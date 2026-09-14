const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const games = {};

// =====================================================
// BASIC HELPERS
// =====================================================

function createRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;

    do {
        code = "";

        for (let i = 0; i < 5; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
    } while (games[code]);

    return code;
}

function getGame(code) {
    if (!code) return null;
    return games[String(code).toUpperCase()];
}

function getPlayer(game, id) {
    if (!game) return null;

    return game.players.find(player => player.id === id);
}

function getAlivePlayers(game) {
    return game.players.filter(player => player.alive);
}

function publicPlayers(game) {
    return game.players.map(player => ({
        id: player.id,
        name: player.name,
        alive: player.alive
    }));
}

function sendPlayers(code) {
    const game = getGame(code);
    if (!game) return;

    io.to(code).emit("playersUpdate", {
        players: publicPlayers(game)
    });
}

function sendPhase(code) {
    const game = getGame(code);
    if (!game) return;

    io.to(code).emit("phaseUpdate", {
        phase: game.phase,
        nightStep: game.nightStep,
        round: game.round,
        timeLeft: game.timeLeft
    });
}

function sendSystemMessage(code, message) {
    io.to(code).emit("systemMessage", message);
}

// =====================================================
// TIMER
// =====================================================

function stopTimer(game) {
    if (!game) return;

    if (game.timer) {
        clearInterval(game.timer);
        game.timer = null;
    }
}

function startTimer(code, seconds, callback) {
    const game = getGame(code);

    if (!game) return;

    stopTimer(game);

    game.timeLeft = seconds;

    sendPhase(code);

    game.timer = setInterval(() => {
        if (!getGame(code)) return;

        game.timeLeft--;

        sendPhase(code);

        if (game.timeLeft <= 0) {
            stopTimer(game);
            callback();
        }
    }, 1000);
}

// =====================================================
// ROLES
// =====================================================

function getMafiaCount(playerCount) {
    if (playerCount >= 10) return 3;
    if (playerCount >= 7) return 2;
    return 1;
}

function shuffle(array) {
    const copy = [...array];

    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
}

function createRoles(playerCount) {
    const mafiaCount = getMafiaCount(playerCount);

    const roles = [];

    for (let i = 0; i < mafiaCount; i++) {
        roles.push("Mafia");
    }

    const remaining = playerCount - mafiaCount;

    const otherRoles = [
        "Detective",
        "Doctor",
        "Citizen"
    ];

    for (let i = 0; i < remaining; i++) {
        roles.push(otherRoles[i % 3]);
    }

    return shuffle(roles);
}

// =====================================================
// WINNER
// =====================================================

function checkWinner(code) {
    const game = getGame(code);

    if (!game || game.phase === "ended") return true;

    const alive = getAlivePlayers(game);

    const mafia = alive.filter(
        player => player.role === "Mafia"
    );

    const nonMafia = alive.filter(
        player => player.role !== "Mafia"
    );

    if (mafia.length === 0) {
        endGame(code, "Citizens");
        return true;
    }

    if (mafia.length >= nonMafia.length) {
        endGame(code, "Mafia");
        return true;
    }

    return false;
}

// =====================================================
// END GAME
// =====================================================

function endGame(code, winner) {
    const game = getGame(code);

    if (!game) return;

    stopTimer(game);

    game.phase = "ended";
    game.nightStep = null;
    game.timeLeft = 0;

    io.to(code).emit("gameOver", {
        winner,
        players: game.players.map(player => ({
            name: player.name,
            role: player.role,
            alive: player.alive
        }))
    });

    sendPhase(code);
}

// =====================================================
// PRIVATE ROLE CHAT
// =====================================================

function getChatRoleForNightStep(step) {
    if (step === "mafia") return "Mafia";
    if (step === "doctor") return "Doctor";
    if (step === "detective") return "Detective";

    return null;
}

function sendPrivateRoleChat(game, role, sender, message) {
    game.players.forEach(player => {
        if (
            player.alive &&
            player.role === role
        ) {
            io.to(player.id).emit("chatMessage", {
                name: sender.name,
                message,
                private: true,
                role
            });
        }
    });
}

// =====================================================
// START GAME
// =====================================================

function startGame(code) {
    const game = getGame(code);

    if (!game) return;

    if (game.players.length < 4) {
        io.to(game.host).emit(
            "errorMessage",
            "You need at least 4 players to start."
        );

        return;
    }

    if (game.players.length > 12) {
        return;
    }

    const roles = createRoles(game.players.length);

    game.players.forEach((player, index) => {
        player.role = roles[index];
        player.alive = true;
    });

    game.phase = "night";
    game.round = 1;
    game.nightStep = "mafia";

    game.votes = {};

    game.nightActions = {
        mafia: {},
        mafiaTarget: null,
        doctor: null,
        detective: null
    };

    // Tell everyone their role privately
    game.players.forEach(player => {
        const mafiaMembers = game.players
            .filter(p => p.role === "Mafia")
            .map(p => p.name);

        io.to(player.id).emit("yourRole", {
            role: player.role,
            mafiaMembers:
                player.role === "Mafia"
                    ? mafiaMembers
                    : []
        });
    });

    sendPlayers(code);

    sendSystemMessage(
        code,
        "🌙 Night 1 has begun."
    );

    startMafiaPhase(code);
}

// =====================================================
// NIGHT: MAFIA
// =====================================================

function startMafiaPhase(code) {
    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "mafia";

    game.nightActions.mafia = {};

    sendPhase(code);

    const mafiaPlayers = game.players.filter(
        player =>
            player.role === "Mafia" &&
            player.alive
    );

    if (mafiaPlayers.length === 0) {
        startDoctorPhase(code);
        return;
    }

    game.players.forEach(player => {
        if (!player.alive) return;

        if (player.role === "Mafia") {
            const targets = game.players
                .filter(
                    target =>
                        target.alive &&
                        target.role !== "Mafia"
                )
                .map(target => ({
                    id: target.id,
                    name: target.name
                }));

            io.to(player.id).emit(
                "nightStarted",
                {
                    step: "mafia",
                    title: "Mafia Decision",
                    message: "Choose someone to attack.",
                    targets
                }
            );
        } else {
            io.to(player.id).emit(
                "nightStarted",
                {
                    step: "mafia",
                    title: "Mafia Decision",
                    message: "The Mafia are deciding who to attack.",
                    targets: []
                }
            );
        }
    });

    startTimer(code, 30, () => {
        finishMafiaPhase(code);
    });
}

function mafiaAction(socket, data) {
    const game = getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "mafia"
    ) {
        return;
    }

    const player = getPlayer(game, socket.id);
    const target = getPlayer(game, data.targetId);

    if (!player || !target) return;

    if (
        player.role !== "Mafia" ||
        !player.alive
    ) {
        return;
    }

    if (!target.alive) return;
    if (target.role === "Mafia") return;

    game.nightActions.mafia[player.id] =
        target.id;

    socket.emit("actionSubmitted", {
        message: "Mafia decision submitted."
    });

    const livingMafia = game.players.filter(
        p =>
            p.role === "Mafia" &&
            p.alive
    );

    const submitted = Object.keys(
        game.nightActions.mafia
    ).length;

    if (submitted >= livingMafia.length) {
        finishMafiaPhase(data.code);
    }
}

function finishMafiaPhase(code) {
    const game = getGame(code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "mafia"
    ) {
        return;
    }

    stopTimer(game);

    const choices = Object.values(
        game.nightActions.mafia
    );

    let target = null;

    if (choices.length > 0) {
        const counts = {};

        choices.forEach(id => {
            counts[id] = (counts[id] || 0) + 1;
        });

        let highest = 0;

        Object.keys(counts).forEach(id => {
            if (counts[id] > highest) {
                highest = counts[id];
                target = id;
            }
        });
    }

    game.nightActions.mafiaTarget = target;

    startDoctorPhase(code);
}

// =====================================================
// NIGHT: DOCTOR
// =====================================================

function startDoctorPhase(code) {
    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "doctor";
    game.nightActions.doctor = null;

    sendPhase(code);

    const doctors = game.players.filter(
        player =>
            player.role === "Doctor" &&
            player.alive
    );

    if (doctors.length === 0) {
        startDetectivePhase(code);
        return;
    }

    game.players.forEach(player => {
        if (!player.alive) return;

        if (player.role === "Doctor") {
            const targets = game.players
                .filter(target => target.alive)
                .map(target => ({
                    id: target.id,
                    name: target.name
                }));

            io.to(player.id).emit(
                "nightStarted",
                {
                    step: "doctor",
                    title: "Doctor Decision",
                    message: "Choose someone to protect.",
                    targets
                }
            );
        } else {
            io.to(player.id).emit(
                "nightStarted",
                {
                    step: "doctor",
                    title: "Doctor Decision",
                    message: "The Doctor is deciding who to protect.",
                    targets: []
                }
            );
        }
    });

    startTimer(code, 30, () => {
        finishDoctorPhase(code);
    });
}

function doctorAction(socket, data) {
    const game = getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "doctor"
    ) {
        return;
    }

    const player = getPlayer(game, socket.id);
    const target = getPlayer(game, data.targetId);

    if (!player || !target) return;

    if (
        player.role !== "Doctor" ||
        !player.alive
    ) {
        return;
    }

    if (!target.alive) return;

    game.nightActions.doctor = target.id;

    socket.emit("actionSubmitted", {
        message: "Doctor decision submitted."
    });

    finishDoctorPhase(data.code);
}

function finishDoctorPhase(code) {
    const game = getGame(code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "doctor"
    ) {
        return;
    }

    stopTimer(game);

    startDetectivePhase(code);
}

// =====================================================
// NIGHT: DETECTIVE
// =====================================================

function startDetectivePhase(code) {
    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "detective";
    game.nightActions.detective = null;

    sendPhase(code);

    const detectives = game.players.filter(
        player =>
            player.role === "Detective" &&
            player.alive
    );

    if (detectives.length === 0) {
        finishDetectivePhase(code);
        return;
    }

    game.players.forEach(player => {
        if (!player.alive) return;

        if (player.role === "Detective") {
            const targets = game.players
                .filter(
                    target =>
                        target.alive &&
                        target.id !== player.id
                )
                .map(target => ({
                    id: target.id,
                    name: target.name
                }));

            io.to(player.id).emit(
                "nightStarted",
                {
                    step: "detective",
                    title: "Detective Decision",
                    message: "Choose someone to investigate.",
                    targets
                }
            );
        } else {
            io.to(player.id).emit(
                "nightStarted",
                {
                    step: "detective",
                    title: "Detective Decision",
                    message: "The Detective is investigating someone.",
                    targets: []
                }
            );
        }
    });

    startTimer(code, 30, () => {
        finishDetectivePhase(code);
    });
}

function detectiveAction(socket, data) {
    const game = getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "detective"
    ) {
        return;
    }

    const player = getPlayer(game, socket.id);
    const target = getPlayer(game, data.targetId);

    if (!player || !target) return;

    if (
        player.role !== "Detective" ||
        !player.alive
    ) {
        return;
    }

    if (!target.alive) return;
    if (target.id === player.id) return;

    game.nightActions.detective = target.id;

    io.to(player.id).emit(
        "detectiveResult",
        {
            name: target.name,
            mafia: target.role === "Mafia"
        }
    );

    socket.emit("actionSubmitted", {
        message: "Investigation submitted."
    });

    finishDetectivePhase(data.code);
}

// =====================================================
// FINISH NIGHT
// =====================================================

function finishDetectivePhase(code) {
    const game = getGame(code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "detective"
    ) {
        return;
    }

    stopTimer(game);

    const mafiaTarget =
        game.nightActions.mafiaTarget;

    const doctorTarget =
        game.nightActions.doctor;

    let nightMessage =
        "🌙 Nobody was eliminated during the night.";

    if (mafiaTarget) {
        const target = getPlayer(
            game,
            mafiaTarget
        );

        if (
            target &&
            target.alive
        ) {
            if (doctorTarget === mafiaTarget) {
                nightMessage =
                    "🩺 The Doctor saved someone from the Mafia!";
            } else {
                target.alive = false;

                nightMessage =
                    `💀 ${target.name} was eliminated during the night.`;
            }
        }
    }

    sendSystemMessage(code, nightMessage);

    sendPlayers(code);

    if (checkWinner(code)) {
        return;
    }

    setTimeout(() => {
        const currentGame = getGame(code);

        if (
            !currentGame ||
            currentGame.phase === "ended"
        ) {
            return;
        }

        startDay(code);
    }, 3000);
}

// =====================================================
// DAY
// =====================================================

function startDay(code) {
    const game = getGame(code);

    if (!game) return;

    game.phase = "day";
    game.nightStep = null;
    game.votes = {};

    sendPhase(code);

    sendSystemMessage(
        code,
        `☀️ Day ${game.round} has begun. Everyone alive can talk and vote.`
    );

    io.to(code).emit("dayStarted");

    startTimer(code, 60, () => {
        finishVoting(code);
    });
}

// =====================================================
// VOTING
// =====================================================

function sendVoteTargets(socket, game) {
    const player = getPlayer(game, socket.id);

    if (!player || !player.alive) {
        socket.emit("voteTargets", {
            targets: []
        });

        return;
    }

    const targets = game.players
        .filter(
            target =>
                target.alive &&
                target.id !== player.id
        )
        .map(target => ({
            id: target.id,
            name: target.name
        }));

    socket.emit("voteTargets", {
        targets
    });
}

function vote(socket, data) {
    const game = getGame(data.code);

    if (!game) return;

    if (game.phase !== "day") return;

    const player = getPlayer(game, socket.id);
    const target = getPlayer(game, data.targetId);

    if (!player || !target) return;

    if (!player.alive) return;
    if (!target.alive) return;
    if (player.id === target.id) return;

    game.votes[player.id] = target.id;

    socket.emit("voteSubmitted", {
        targetName: target.name
    });

    const alive = getAlivePlayers(game);

    const voteCount = Object.keys(game.votes).length;

    if (voteCount >= alive.length) {
        finishVoting(data.code);
    }
}

function finishVoting(code) {
    const game = getGame(code);

    if (!game) return;

    if (game.phase !== "day") return;

    stopTimer(game);

    const counts = {};

    Object.values(game.votes).forEach(targetId => {
        counts[targetId] =
            (counts[targetId] || 0) + 1;
    });

    let eliminatedId = null;
    let highest = 0;

    Object.keys(counts).forEach(id => {
        if (counts[id] > highest) {
            highest = counts[id];
            eliminatedId = id;
        }
    });

    if (!eliminatedId) {
        sendSystemMessage(
            code,
            "⚖️ Nobody was eliminated today."
        );
    } else {
        const target = getPlayer(
            game,
            eliminatedId
        );

        if (target && target.alive) {
            target.alive = false;

            sendSystemMessage(
                code,
                `⚖️ ${target.name} was eliminated by vote. They were ${target.role}.`
            );
        }
    }

    sendPlayers(code);

    if (checkWinner(code)) {
        return;
    }

    setTimeout(() => {
        const currentGame = getGame(code);

        if (
            !currentGame ||
            currentGame.phase === "ended"
        ) {
            return;
        }

        currentGame.round++;

        startNight(code);
    }, 3000);
}

// =====================================================
// NEXT NIGHT
// =====================================================

function startNight(code) {
    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "mafia";

    game.nightActions = {
        mafia: {},
        mafiaTarget: null,
        doctor: null,
        detective: null
    };

    sendSystemMessage(
        code,
        `🌙 Night ${game.round} has begun.`
    );

    startMafiaPhase(code);
}

// =====================================================
// CHAT
// =====================================================

function handleChat(socket, data) {
    const game = getGame(data.code);

    if (!game) return;

    const player = getPlayer(game, socket.id);

    if (!player) return;

    if (!player.alive) return;

    const message =
        String(data.message || "")
            .trim()
            .slice(0, 300);

    if (!message) return;

    // DAY CHAT
    if (game.phase === "day") {
        io.to(data.code).emit(
            "chatMessage",
            {
                name: player.name,
                message,
                private: false
            }
        );

        return;
    }

    // NIGHT CHAT
    if (game.phase === "night") {
        const allowedRole =
            getChatRoleForNightStep(
                game.nightStep
            );

        if (
            allowedRole &&
            player.role === allowedRole
        ) {
            sendPrivateRoleChat(
                game,
                allowedRole,
                player,
                message
            );
        }
    }
}

// =====================================================
// SOCKET CONNECTION
// =====================================================

io.on("connection", socket => {

    // -------------------------------------------------
    // CREATE GAME
    // -------------------------------------------------

    socket.on("createGame", data => {
        const name =
            String(data.name || "")
                .trim()
                .slice(0, 20);

        if (!name) {
            socket.emit(
                "errorMessage",
                "Enter a name first."
            );

            return;
        }

        const code = createRoomCode();

        const game = {
            code,
            host: socket.id,

            players: [
                {
                    id: socket.id,
                    name,
                    role: null,
                    alive: true
                }
            ],

            phase: "lobby",
            round: 0,
            nightStep: null,

            votes: {},

            nightActions: {
                mafia: {},
                mafiaTarget: null,
                doctor: null,
                detective: null
            },

            timer: null,
            timeLeft: 0
        };

        games[code] = game;

        socket.join(code);

        socket.emit("gameCreated", {
            code,
            host: true
        });

        sendPlayers(code);

        sendSystemMessage(
            code,
            `${name} created the game.`
        );
    });

    // -------------------------------------------------
    // JOIN GAME
    // -------------------------------------------------

    socket.on("joinGame", data => {
        const code =
            String(data.code || "")
                .trim()
                .toUpperCase();

        const name =
            String(data.name || "")
                .trim()
                .slice(0, 20);

        const game = getGame(code);

        if (!game) {
            socket.emit(
                "errorMessage",
                "That room does not exist."
            );

            return;
        }

        if (game.phase !== "lobby") {
            socket.emit(
                "errorMessage",
                "That game has already started."
            );

            return;
        }

        if (game.players.length >= 12) {
            socket.emit(
                "errorMessage",
                "That room is full."
            );

            return;
        }

        if (!name) {
            socket.emit(
                "errorMessage",
                "Enter a name first."
            );

            return;
        }

        const duplicate =
            game.players.some(
                player =>
                    player.name.toLowerCase() ===
                    name.toLowerCase()
            );

        if (duplicate) {
            socket.emit(
                "errorMessage",
                "That name is already being used."
            );

            return;
        }

        game.players.push({
            id: socket.id,
            name,
            role: null,
            alive: true
        });

        socket.join(code);

        socket.emit("gameJoined", {
            code,
            host: false
        });

        sendPlayers(code);

        sendSystemMessage(
            code,
            `${name} joined the game.`
        );

        io.to(code).emit("hostUpdate", {
            hostId: game.host
        });
    });

    // -------------------------------------------------
    // START GAME
    // -------------------------------------------------

    socket.on("startGame", data => {
        const game = getGame(data.code);

        if (!game) return;

        if (game.host !== socket.id) return;

        if (game.phase !== "lobby") return;

        if (game.players.length < 4) {
            socket.emit(
                "errorMessage",
                "You need at least 4 players."
            );

            return;
        }

        startGame(data.code);
    });

    // -------------------------------------------------
    // NIGHT ACTION
    // -------------------------------------------------

    socket.on("nightAction", data => {
        const step = data.step;

        if (step === "mafia") {
            mafiaAction(socket, data);
        }

        if (step === "doctor") {
            doctorAction(socket, data);
        }

        if (step === "detective") {
            detectiveAction(socket, data);
        }
    });

    // -------------------------------------------------
    // OLD EVENT NAMES ALSO WORK
    // -------------------------------------------------

    socket.on("mafiaAction", data => {
        mafiaAction(socket, data);
    });

    socket.on("doctorAction", data => {
        doctorAction(socket, data);
    });

    socket.on("detectiveAction", data => {
        detectiveAction(socket, data);
    });

    // -------------------------------------------------
    // REQUEST VOTE TARGETS
    // -------------------------------------------------

    socket.on("requestVoteTargets", data => {
        const game = getGame(data.code);

        if (!game) return;

        if (game.phase !== "day") return;

        sendVoteTargets(socket, game);
    });

    // -------------------------------------------------
    // VOTE
    // -------------------------------------------------

    socket.on("vote", data => {
        vote(socket, data);
    });

    // -------------------------------------------------
    // CHAT
    // -------------------------------------------------

    socket.on("chat", data => {
        handleChat(socket, data);
    });

    // -------------------------------------------------
    // DISCONNECT
    // -------------------------------------------------

    socket.on("disconnect", () => {
        let foundGame = null;

        for (const code of Object.keys(games)) {
            const game = games[code];

            const player = getPlayer(
                game,
                socket.id
            );

            if (player) {
                foundGame = game;
                break;
            }
        }

        if (!foundGame) return;

        const game = foundGame;

        const player = getPlayer(
            game,
            socket.id
        );

        if (!player) return;

        // LOBBY
        if (game.phase === "lobby") {
            game.players =
                game.players.filter(
                    p => p.id !== socket.id
                );

            if (game.host === socket.id) {
                if (game.players.length > 0) {
                    game.host =
                        game.players[0].id;
                } else {
                    delete games[game.code];
                    return;
                }
            }

            sendPlayers(game.code);

            io.to(game.code).emit(
                "hostUpdate",
                {
                    hostId: game.host
                }
            );

            sendSystemMessage(
                game.code,
                `${player.name} left the lobby.`
            );

            return;
        }

        // ACTIVE GAME
        if (
            game.phase === "day" ||
            game.phase === "night"
        ) {
            player.alive = false;

            sendSystemMessage(
                game.code,
                `${player.name} disconnected and is now out of the game.`
            );

            sendPlayers(game.code);

            if (checkWinner(game.code)) {
                return;
            }

            // If a Mafia disconnects during Mafia phase
            if (
                game.phase === "night" &&
                game.nightStep === "mafia"
            ) {
                const livingMafia =
                    game.players.filter(
                        p =>
                            p.alive &&
                            p.role === "Mafia"
                    );

                const submitted =
                    Object.keys(
                        game.nightActions.mafia
                    ).length;

                if (
                    livingMafia.length === 0 ||
                    submitted >= livingMafia.length
                ) {
                    finishMafiaPhase(game.code);
                }
            }

            return;
        }
    });
});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, () => {
    console.log(
        `Global Mafia running on port ${PORT}`
    );
});
