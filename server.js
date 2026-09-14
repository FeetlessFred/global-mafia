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
// HELPERS
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
        timeLeft: game.timeLeft
    });
}


function sendSystemMessage(code, message) {
    io.to(code).emit("systemMessage", message);
}


function stopTimer(game) {
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

function createRoles(playerCount) {

    const roles = [];

    let mafiaCount = 1;

    if (playerCount >= 8) {
        mafiaCount = 2;
    }

    if (playerCount >= 11) {
        mafiaCount = 3;
    }

    for (let i = 0; i < mafiaCount; i++) {
        roles.push("Mafia");
    }

    roles.push("Detective");
    roles.push("Doctor");

    while (roles.length < playerCount) {
        roles.push("Citizen");
    }

    // Shuffle roles
    for (let i = roles.length - 1; i > 0; i--) {

        const j = Math.floor(Math.random() * (i + 1));

        [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    return roles;
}


// =====================================================
// WINNER CHECK
// =====================================================

function checkWinner(code) {

    const game = getGame(code);

    if (!game) return true;

    const alive = getAlivePlayers(game);

    const mafia = alive.filter(
        player => player.role === "Mafia"
    );

    const citizens = alive.filter(
        player => player.role !== "Mafia"
    );

    // All Mafia eliminated
    if (mafia.length === 0) {

        endGame(code, "Citizens");

        return true;
    }

    // Mafia equal or outnumber everyone else
    if (mafia.length >= citizens.length) {

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

    io.to(code).emit("gameOver", {

        winner,

        players: game.players.map(player => ({
            name: player.name,
            role: player.role
        }))

    });

    sendPhase(code);
}


// =====================================================
// START GAME
// =====================================================

function startGame(code) {

    const game = getGame(code);

    if (!game) return;

    const roles = createRoles(
        game.players.length
    );

    game.players.forEach((player, index) => {

        player.role = roles[index];
        player.alive = true;

    });

    game.phase = "night";
    game.round = 1;

    game.nightActions = {
        mafia: {},
        doctor: null,
        detective: null
    };

    game.votes = {};

    // Give every player their private role
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

    startNight(code);
}


// =====================================================
// NIGHT
// =====================================================

function startNight(code) {

    const game = getGame(code);

    if (!game) return;

    game.phase = "night";

    game.nightActions = {
        mafia: {},
        doctor: null,
        detective: null
    };

    sendPhase(code);

    game.players.forEach(player => {

        if (!player.alive) return;

        let message;

        if (player.role === "Mafia") {

            message =
                "🔴 Choose someone for the Mafia to attack.";

        } else if (player.role === "Doctor") {

            message =
                "🩺 Choose someone to protect.";

        } else if (player.role === "Detective") {

            message =
                "🔎 Choose someone to investigate.";

        } else {

            message =
                "😴 You are asleep. Wait for morning.";
        }

        io.to(player.id).emit(
            "nightStarted",
            {
                message,

                targets: game.players
                    .filter(p => p.alive)
                    .map(p => ({
                        id: p.id,
                        name: p.name
                    }))
            }
        );
    });

    // Night lasts 30 seconds
    startTimer(code, 30, () => {
        finishNight(code);
    });
}


// =====================================================
// NIGHT ACTION
// =====================================================

function nightAction(socket, data) {

    const game = getGame(data.code);

    if (!game) return;

    if (game.phase !== "night") return;

    const player =
        getPlayer(game, socket.id);

    const target =
        getPlayer(game, data.targetId);

    if (!player || !target) return;

    if (!player.alive || !target.alive) return;

    // Can't target yourself
    if (player.id === target.id) return;


    // Mafia
    if (player.role === "Mafia") {

        game.nightActions.mafia[player.id] =
            target.id;
    }


    // Doctor
    else if (player.role === "Doctor") {

        game.nightActions.doctor =
            target.id;
    }


    // Detective
    else if (player.role === "Detective") {

        game.nightActions.detective =
            target.id;
    }


    socket.emit("actionSubmitted");
}


// =====================================================
// FINISH NIGHT
// =====================================================

function finishNight(code) {

    const game = getGame(code);

    if (!game) return;

    if (game.phase !== "night") return;

    stopTimer(game);


    // ---------------------------------------------
    // Mafia target
    // ---------------------------------------------

    const mafiaChoices =
        Object.values(
            game.nightActions.mafia
        );

    let mafiaTarget = null;

    if (mafiaChoices.length > 0) {

        const counts = {};

        mafiaChoices.forEach(id => {

            counts[id] =
                (counts[id] || 0) + 1;

        });

        mafiaTarget =
            Object.keys(counts).sort(
                (a, b) =>
                    counts[b] - counts[a]
            )[0];
    }


    // ---------------------------------------------
    // Doctor target
    // ---------------------------------------------

    const doctorTarget =
        game.nightActions.doctor;


    // ---------------------------------------------
    // Detective investigation
    // ---------------------------------------------

    const detectiveTarget =
        game.nightActions.detective;

    const detective =
        game.players.find(
            player =>
                player.role === "Detective" &&
                player.alive
        );

    if (detective && detectiveTarget) {

        const target =
            getPlayer(
                game,
                detectiveTarget
            );

        if (target) {

            io.to(detective.id).emit(
                "detectiveResult",
                {
                    name: target.name,

                    mafia:
                        target.role === "Mafia"
                }
            );
        }
    }


    // ---------------------------------------------
    // Resolve Mafia attack
    // ---------------------------------------------

    let nightMessage =
        "🌙 Nothing happened during the night.";

    if (mafiaTarget) {

        const target =
            getPlayer(
                game,
                mafiaTarget
            );

        if (
            target &&
            mafiaTarget !== doctorTarget
        ) {

            target.alive = false;

            nightMessage =
                `💀 ${target.name} was eliminated during the night.`;

        } else if (
            target &&
            mafiaTarget === doctorTarget
        ) {

            nightMessage =
                "🩺 The Doctor saved someone from an attack!";
        }
    }

    sendSystemMessage(
        code,
        nightMessage
    );

    sendPlayers(code);

    if (checkWinner(code)) return;

    // Give everyone a few seconds to see result
    setTimeout(() => {
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

    game.votes = {};

    sendPhase(code);

    sendSystemMessage(
        code,
        `☀️ Day ${game.round} has begun. Discuss!`
    );

    io.to(code).emit("dayStarted");

    // 60 second discussion/voting period
    startTimer(code, 60, () => {
        finishVoting(code);
    });
}


// =====================================================
// VOTING
// =====================================================

function vote(socket, data) {

    const game =
        getGame(data.code);

    if (!game) return;

    if (game.phase !== "day") return;

    const player =
        getPlayer(
            game,
            socket.id
        );

    const target =
        getPlayer(
            game,
            data.targetId
        );

    if (!player || !target) return;

    if (!player.alive) return;

    if (!target.alive) return;

    if (player.id === target.id) return;

    game.votes[player.id] =
        target.id;

    socket.emit(
        "voteSubmitted"
    );

    const alive =
        getAlivePlayers(game);

    const submittedVotes =
        Object.keys(game.votes).length;

    // Everyone alive has voted
    if (
        submittedVotes >=
        alive.length
    ) {

        finishVoting(
            data.code
        );
    }
}


// =====================================================
// FINISH VOTING
// =====================================================

function finishVoting(code) {

    const game = getGame(code);

    if (!game) return;

    if (game.phase !== "day") return;

    stopTimer(game);

    const counts = {};

    Object.values(game.votes)
        .forEach(targetId => {

            counts[targetId] =
                (counts[targetId] || 0) + 1;

        });

    const entries =
        Object.entries(counts);


    // Nobody voted
    if (entries.length === 0) {

        sendSystemMessage(
            code,
            "🗳️ Nobody received a vote."
        );

    } else {

        entries.sort(
            (a, b) =>
                b[1] - a[1]
        );

        const highest =
            entries[0][1];

        const winners =
            entries.filter(
                entry =>
                    entry[1] === highest
            );


        // Tie
        if (winners.length > 1) {

            sendSystemMessage(
                code,
                "🤝 The vote was tied. Nobody was eliminated."
            );

        } else {

            const eliminated =
                getPlayer(
                    game,
                    winners[0][0]
                );

            if (eliminated) {

                eliminated.alive = false;

                sendSystemMessage(
                    code,
                    `🗳️ ${eliminated.name} was voted out.`
                );

                sendSystemMessage(
                    code,
                    `${eliminated.name}'s role was ${eliminated.role}.`
                );
            }
        }
    }

    sendPlayers(code);

    if (checkWinner(code)) return;

    setTimeout(() => {

        game.round++;

        startNight(code);

    }, 4000);
}


// =====================================================
// CHAT
// =====================================================

function sendChat(socket, data) {

    const game =
        getGame(data.code);

    if (!game) return;

    const player =
        getPlayer(
            game,
            socket.id
        );

    if (!player) return;

    // Dead players cannot use normal chat
    if (!player.alive) return;

    const message =
        String(data.message || "")
            .trim()
            .substring(0, 200);

    if (!message) return;

    io.to(data.code).emit(
        "chatMessage",
        {
            name: player.name,
            message
        }
    );
}


// =====================================================
// SOCKET CONNECTION
// =====================================================

io.on("connection", socket => {

    console.log(
        "Player connected:",
        socket.id
    );


    // =================================================
    // CREATE GAME
    // =================================================

    socket.on(
        "createGame",
        name => {

            name =
                String(name || "")
                    .trim()
                    .substring(0, 20);

            if (!name) {

                socket.emit(
                    "errorMessage",
                    "Enter a name."
                );

                return;
            }

            const code =
                createRoomCode();

            games[code] = {

                host: socket.id,

                players: [
                    {
                        id: socket.id,
                        name,
                        alive: true,
                        role: null
                    }
                ],

                phase: "lobby",

                round: 0,

                votes: {},

                nightActions: {},

                timer: null,

                timeLeft: 0
            };

            socket.join(code);

            socket.data.room =
                code;

            socket.emit(
                "gameCreated",
                {
                    code
                }
            );

            sendPlayers(code);
        }
    );


    // =================================================
    // JOIN GAME
    // =================================================

    socket.on(
        "joinGame",
        data => {

            const code =
                String(data.code || "")
                    .trim()
                    .toUpperCase();

            const name =
                String(data.name || "")
                    .trim()
                    .substring(0, 20);

            const game =
                getGame(code);


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
                    "Enter a name."
                );

                return;
            }


            // Prevent duplicate names
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

                alive: true,

                role: null

            });


            socket.join(code);

            socket.data.room =
                code;


            socket.emit(
                "gameJoined",
                {
                    code
                }
            );


            sendPlayers(code);
        }
    );


    // =================================================
    // START GAME
    // =================================================

    socket.on(
        "startGame",
        code => {

            const game =
                getGame(code);

            if (!game) return;


            // Only host can start
            if (
                game.host !==
                socket.id
            ) return;


            // Minimum 4 players
            if (
                game.players.length < 4
            ) {

                socket.emit(
                    "errorMessage",
                    "You need at least 4 players."
                );

                return;
            }


            startGame(code);
        }
    );


    // =================================================
    // NIGHT ACTION
    // =================================================

    socket.on(
        "nightAction",
        data => {

            nightAction(
                socket,
                data
            );
        }
    );


    // =================================================
    // GET VOTE TARGETS
    // =================================================

    socket.on(
        "requestVoteTargets",
        code => {

            const game =
                getGame(code);

            if (!game) return;

            if (game.phase !== "day")
                return;

            const player =
                getPlayer(
                    game,
                    socket.id
                );

            if (!player || !player.alive)
                return;

            socket.emit(
                "voteTargets",
                publicPlayers(game)
            );
        }
    );


    // =================================================
    // VOTE
    // =================================================

    socket.on(
        "vote",
        data => {

            vote(
                socket,
                data
            );
        }
    );


    // =================================================
    // CHAT
    // =================================================

    socket.on(
        "chat",
        data => {

            sendChat(
                socket,
                data
            );
        }
    );


    // =================================================
    // DISCONNECT
    // =================================================

    socket.on(
        "disconnect",
        () => {

            console.log(
                "Player disconnected:",
                socket.id
            );


            const code =
                socket.data.room;

            if (!code) return;


            const game =
                getGame(code);

            if (!game) return;


            const player =
                getPlayer(
                    game,
                    socket.id
                );

            if (!player) return;


            // -----------------------------------------
            // Lobby
            // -----------------------------------------

            if (
                game.phase === "lobby"
            ) {

                game.players =
                    game.players.filter(
                        p =>
                            p.id !==
                            socket.id
                    );


                // Give host to another player
                if (
                    game.host ===
                    socket.id
                ) {

                    if (
                        game.players.length > 0
                    ) {

                        game.host =
                            game.players[0].id;
                    }
                }


                // Delete empty room
                if (
                    game.players.length === 0
                ) {

                    delete games[code];

                    return;
                }


                sendPlayers(code);

                return;
            }


            // -----------------------------------------
            // Active game
            // -----------------------------------------

            player.alive = false;

            sendSystemMessage(
                code,
                `⚠️ ${player.name} disconnected.`
            );

            sendPlayers(code);

            if (
                game.phase !== "ended"
            ) {

                checkWinner(code);
            }
        }
    );

});


// =====================================================
// SERVER START
// =====================================================

server.listen(
    PORT,
    () => {

        console.log(
            `🌎 Global Mafia running on port ${PORT}`
        );

    }
);
