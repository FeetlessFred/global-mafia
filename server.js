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


/* =====================================================
   ROOM / PLAYER FUNCTIONS
===================================================== */

function createRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 5; i++) {
            code += chars[
                Math.floor(Math.random() * chars.length)
            ];
        }

    } while (games[code]);

    return code;
}


function getGame(code) {
    if (!code) return null;

    return games[
        String(code).toUpperCase()
    ];
}


function getPlayer(game, id) {
    return game.players.find(
        player => player.id === id
    );
}


function getAlivePlayers(game) {
    return game.players.filter(
        player => player.alive
    );
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

    io.to(code).emit(
        "playersUpdate",
        {
            players: publicPlayers(game)
        }
    );
}


function sendPhase(code) {
    const game = getGame(code);

    if (!game) return;

    io.to(code).emit(
        "phaseUpdate",
        {
            phase: game.phase,
            timeLeft: game.timeLeft
        }
    );
}


function sendSystemMessage(code, message) {
    io.to(code).emit(
        "systemMessage",
        message
    );
}


/* =====================================================
   TIMER
===================================================== */

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


/* =====================================================
   ROLES
===================================================== */

function getMafiaCount(playerCount) {

    if (playerCount >= 10) {
        return 3;
    }

    if (playerCount >= 7) {
        return 2;
    }

    return 1;
}


function createRoles(playerCount) {

    const roles = [];

    const mafiaCount =
        getMafiaCount(playerCount);

    for (
        let i = 0;
        i < mafiaCount;
        i++
    ) {
        roles.push("Mafia");
    }

    const remaining =
        playerCount - mafiaCount;

    const otherRoles = [
        "Citizen",
        "Doctor",
        "Detective"
    ];

    for (
        let i = 0;
        i < remaining;
        i++
    ) {

        roles.push(
            otherRoles[
                i % otherRoles.length
            ]
        );

    }

    for (
        let i = roles.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            roles[i],
            roles[j]
        ] =
        [
            roles[j],
            roles[i]
        ];

    }

    return roles;
}


/* =====================================================
   WINNER
===================================================== */

function checkWinner(code) {

    const game = getGame(code);

    if (!game) return true;

    const alive =
        getAlivePlayers(game);

    const mafia =
        alive.filter(
            player =>
                player.role === "Mafia"
        );

    const nonMafia =
        alive.filter(
            player =>
                player.role !== "Mafia"
        );

    if (mafia.length === 0) {

        endGame(
            code,
            "Citizens"
        );

        return true;
    }

    if (
        mafia.length >=
        nonMafia.length
    ) {

        endGame(
            code,
            "Mafia"
        );

        return true;
    }

    return false;
}


/* =====================================================
   END GAME
===================================================== */

function endGame(code, winner) {

    const game = getGame(code);

    if (!game) return;

    stopTimer(game);

    game.phase = "ended";
    game.nightStep = null;

    io.to(code).emit(
        "gameOver",
        {
            winner,

            players:
                game.players.map(
                    player => ({
                        name: player.name,
                        role: player.role
                    })
                )
        }
    );

    sendPhase(code);
}


/* =====================================================
   START GAME
===================================================== */

function startGame(code) {

    const game = getGame(code);

    if (!game) return;

    const roles =
        createRoles(
            game.players.length
        );

    game.players.forEach(
        (player, index) => {

            player.role =
                roles[index];

            player.alive = true;

            player.hasVoted = false;

        }
    );

    game.phase = "night";
    game.round = 1;
    game.nightStep = "mafia";

    game.nightActions = {
        mafia: {},
        mafiaTarget: null,
        doctor: null,
        detective: null
    };

    game.votes = {};

    game.players.forEach(
        player => {

            const mafiaMembers =
                game.players
                    .filter(
                        p =>
                            p.role === "Mafia"
                    )
                    .map(
                        p => p.name
                    );

            io.to(player.id).emit(
                "yourRole",
                {
                    role: player.role,

                    mafiaMembers:
                        player.role === "Mafia"
                            ? mafiaMembers
                            : []
                }
            );

        }
    );

    sendPlayers(code);

    sendSystemMessage(
        code,
        "🌙 Night 1 has begun."
    );

    startMafiaPhase(code);
}


/* =====================================================
   MAFIA PHASE
===================================================== */

function startMafiaPhase(code) {

    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "mafia";

    sendPhase(code);

    const mafiaPlayers =
        game.players.filter(
            player =>
                player.role === "Mafia" &&
                player.alive
        );

    if (mafiaPlayers.length === 0) {

        startDoctorPhase(code);

        return;
    }

    game.nightActions.mafia = {};

    game.players.forEach(
        player => {

            if (!player.alive) return;

            if (player.role === "Mafia") {

                io.to(player.id).emit(
                    "nightStarted",
                    {
                        message:
                            "🔴 Mafia Decision: choose someone to attack.",

                        targets:
                            game.players
                                .filter(
                                    p =>
                                        p.alive &&
                                        p.role !== "Mafia"
                                )
                                .map(
                                    p => ({
                                        id: p.id,
                                        name: p.name
                                    })
                                )
                    }
                );

            } else {

                io.to(player.id).emit(
                    "nightStarted",
                    {
                        message:
                            "😴 The Mafia are making their decision.",

                        targets: []
                    }
                );

            }

        }
    );

    startTimer(
        code,
        30,
        () => {
            finishMafiaPhase(code);
        }
    );
}


/* =====================================================
   MAFIA ACTION
===================================================== */

function mafiaAction(socket, data) {

    const game =
        getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "mafia"
    ) return;

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

    if (
        player.role !== "Mafia" ||
        !player.alive
    ) return;

    if (!target.alive) return;

    if (target.role === "Mafia") return;

    if (
        game.nightActions.mafia[
            player.id
        ]
    ) {
        return;
    }

    game.nightActions.mafia[
        player.id
    ] = target.id;

    socket.emit(
        "actionSubmitted"
    );

    const livingMafia =
        game.players.filter(
            p =>
                p.role === "Mafia" &&
                p.alive
        );

    const submitted =
        Object.keys(
            game.nightActions.mafia
        ).length;

    if (
        submitted >=
        livingMafia.length
    ) {

        finishMafiaPhase(
            data.code
        );

    }
}


/* =====================================================
   FINISH MAFIA
===================================================== */

function finishMafiaPhase(code) {

    const game = getGame(code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "mafia"
    ) return;

    stopTimer(game);

    const mafiaChoices =
        Object.values(
            game.nightActions.mafia
        );

    let mafiaTarget = null;

    if (
        mafiaChoices.length > 0
    ) {

        const counts = {};

        mafiaChoices.forEach(
            id => {

                counts[id] =
                    (counts[id] || 0) + 1;

            }
        );

        mafiaTarget =
            Object.keys(counts)
                .sort(
                    (a, b) =>
                        counts[b] -
                        counts[a]
                )[0];

    }

    game.nightActions.mafiaTarget =
        mafiaTarget;

    startDoctorPhase(code);
}


/* =====================================================
   DOCTOR PHASE
===================================================== */

function startDoctorPhase(code) {

    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "doctor";

    game.nightActions.doctor = null;

    sendPhase(code);

    const doctor =
        game.players.find(
            player =>
                player.role === "Doctor" &&
                player.alive
        );

    if (!doctor) {

        startDetectivePhase(code);

        return;
    }

    game.players.forEach(
        player => {

            if (!player.alive) return;

            if (player.role === "Doctor") {

                io.to(player.id).emit(
                    "nightStarted",
                    {
                        message:
                            "🩺 Doctor Decision: choose someone to protect.",

                        targets:
                            game.players
                                .filter(
                                    p =>
                                        p.alive
                                )
                                .map(
                                    p => ({
                                        id: p.id,
                                        name: p.name
                                    })
                                )
                    }
                );

            } else {

                io.to(player.id).emit(
                    "nightStarted",
                    {
                        message:
                            "😴 The Doctor is making their decision.",

                        targets: []
                    }
                );

            }

        }
    );

    startTimer(
        code,
        30,
        () => {
            finishDoctorPhase(code);
        }
    );
}


/* =====================================================
   DOCTOR ACTION
===================================================== */

function doctorAction(socket, data) {

    const game =
        getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "doctor"
    ) return;

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

    if (
        player.role !== "Doctor" ||
        !player.alive
    ) return;

    if (!target.alive) return;

    if (
        game.nightActions.doctor
    ) {
        return;
    }

    game.nightActions.doctor =
        target.id;

    socket.emit(
        "actionSubmitted"
    );

    finishDoctorPhase(
        data.code
    );
}


function finishDoctorPhase(code) {

    const game = getGame(code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "doctor"
    ) return;

    stopTimer(game);

    startDetectivePhase(code);
}


/* =====================================================
   DETECTIVE PHASE
===================================================== */

function startDetectivePhase(code) {

    const game = getGame(code);

    if (!game) return;

    game.phase = "night";
    game.nightStep = "detective";

    game.nightActions.detective = null;

    sendPhase(code);

    const detective =
        game.players.find(
            player =>
                player.role === "Detective" &&
                player.alive
        );

    if (!detective) {

        finishDetectivePhase(code);

        return;
    }

    game.players.forEach(
        player => {

            if (!player.alive) return;

            if (
                player.role ===
                "Detective"
            ) {

                io.to(player.id).emit(
                    "nightStarted",
                    {
                        message:
                            "🔎 Detective Decision: choose someone to investigate.",

                        targets:
                            game.players
                                .filter(
                                    p =>
                                        p.alive &&
                                        p.id !== player.id
                                )
                                .map(
                                    p => ({
                                        id: p.id,
                                        name: p.name
                                    })
                                )
                    }
                );

            } else {

                io.to(player.id).emit(
                    "nightStarted",
                    {
                        message:
                            "😴 The Detective is making their decision.",

                        targets: []
                    }
                );

            }

        }
    );

    startTimer(
        code,
        30,
        () => {
            finishDetectivePhase(code);
        }
    );
}


/* =====================================================
   DETECTIVE ACTION
===================================================== */

function detectiveAction(socket, data) {

    const game =
        getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "detective"
    ) return;

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

    if (
        player.role !== "Detective" ||
        !player.alive
    ) return;

    if (!target.alive) return;

    if (
        player.id === target.id
    ) return;

    if (
        game.nightActions.detective
    ) {
        return;
    }

    game.nightActions.detective =
        target.id;

    socket.emit(
        "actionSubmitted"
    );

    socket.emit(
        "detectiveResult",
        {
            name: target.name,

            mafia:
                target.role === "Mafia"
        }
    );

    finishDetectivePhase(
        data.code
    );
}


/* =====================================================
   FINISH NIGHT
===================================================== */

function finishDetectivePhase(code) {

    const game = getGame(code);

    if (!game) return;

    if (
        game.phase !== "night" ||
        game.nightStep !== "detective"
    ) return;

    stopTimer(game);

    const mafiaTarget =
        game.nightActions.mafiaTarget;

    const doctorTarget =
        game.nightActions.doctor;

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

    if (
        checkWinner(code)
    ) {
        return;
    }

    setTimeout(
        () => {

            startDay(code);

        },
        3000
    );
}


/* =====================================================
   DAY
===================================================== */

function startDay(code) {

    const game = getGame(code);

    if (!game) return;

    game.phase = "day";
    game.nightStep = null;

    /*
       IMPORTANT:
       Reset every player's vote here.
       This is a brand-new voting period.
    */

    game.votes = {};

    game.players.forEach(
        player => {
            player.hasVoted = false;
        }
    );

    sendPhase(code);

    sendSystemMessage(
        code,
        `☀️ Day ${game.round} has begun. Everyone can talk!`
    );

    io.to(code).emit(
        "dayStarted"
    );

    startTimer(
        code,
        60,
        () => {
            finishVoting(code);
        }
    );
}


/* =====================================================
   VOTING
===================================================== */

function vote(socket, data) {

    const game =
        getGame(data.code);

    if (!game) return;

    if (
        game.phase !== "day"
    ) {
        return;
    }

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

    if (!player || !target) {
        return;
    }

    if (!player.alive) {
        return;
    }

    if (!target.alive) {
        return;
    }

    if (
        player.id === target.id
    ) {
        return;
    }


    /*
       =================================================
       IMPORTANT ONE-VOTE CHECK
       =================================================

       If this player has already voted,
       the server completely ignores the
       second vote.
    */

    if (player.hasVoted) {

        socket.emit(
            "errorMessage",
            "🗳️ You have already voted. You cannot change your vote."
        );

        return;
    }


    /*
       Mark the player as having voted BEFORE
       storing the vote.
    */

    player.hasVoted = true;

    game.votes[player.id] =
        target.id;


    socket.emit(
        "voteSubmitted",
        {
            targetName: target.name
        }
    );


    sendSystemMessage(
        data.code,
        `🗳️ ${player.name} has voted.`
    );


    const alive =
        getAlivePlayers(game);

    const submittedVotes =
        Object.keys(
            game.votes
        ).length;


    if (
        submittedVotes >=
        alive.length
    ) {

        finishVoting(
            data.code
        );

    }

}


/* =====================================================
   FINISH VOTING
===================================================== */

function finishVoting(code) {

    const game =
        getGame(code);

    if (!game) return;

    if (
        game.phase !== "day"
    ) {
        return;
    }

    stopTimer(game);

    const counts = {};

    Object.values(
        game.votes
    ).forEach(
        targetId => {

            counts[targetId] =
                (counts[targetId] || 0) + 1;

        }
    );

    const entries =
        Object.entries(counts);

    if (
        entries.length === 0
    ) {

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

        if (
            winners.length > 1
        ) {

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

                eliminated.alive =
                    false;

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

    if (
        checkWinner(code)
    ) {
        return;
    }

    setTimeout(
        () => {

            game.round++;

            startMafiaPhase(code);

        },
        4000
    );
}


/* =====================================================
   CHAT
===================================================== */

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

    if (!player.alive) return;

    const message =
        String(
            data.message || ""
        )
        .trim()
        .substring(0, 200);

    if (!message) return;


    /* DAY CHAT */

    if (
        game.phase === "day"
    ) {

        io.to(data.code).emit(
            "chatMessage",
            {
                name: player.name,
                message
            }
        );

        return;
    }


    /* NIGHT CHAT */

    if (
        game.phase !== "night"
    ) {
        return;
    }


    /* MAFIA CHAT */

    if (
        game.nightStep === "mafia" &&
        player.role === "Mafia"
    ) {

        game.players
            .filter(
                p =>
                    p.alive &&
                    p.role === "Mafia"
            )
            .forEach(
                mafiaPlayer => {

                    io.to(
                        mafiaPlayer.id
                    ).emit(
                        "chatMessage",
                        {
                            name: player.name,
                            message
                        }
                    );

                }
            );

        return;
    }


    /* DOCTOR CHAT */

    if (
        game.nightStep === "doctor" &&
        player.role === "Doctor"
    ) {

        game.players
            .filter(
                p =>
                    p.alive &&
                    p.role === "Doctor"
            )
            .forEach(
                doctorPlayer => {

                    io.to(
                        doctorPlayer.id
                    ).emit(
                        "chatMessage",
                        {
                            name: player.name,
                            message
                        }
                    );

                }
            );

        return;
    }


    /* DETECTIVE CHAT */

    if (
        game.nightStep === "detective" &&
        player.role === "Detective"
    ) {

        game.players
            .filter(
                p =>
                    p.alive &&
                    p.role === "Detective"
            )
            .forEach(
                detectivePlayer => {

                    io.to(
                        detectivePlayer.id
                    ).emit(
                        "chatMessage",
                        {
                            name: player.name,
                            message
                        }
                    );

                }
            );

        return;
    }


    socket.emit(
        "errorMessage",
        "💤 You cannot chat during this night phase."
    );
}


/* =====================================================
   SOCKET CONNECTION
===================================================== */

io.on(
    "connection",
    socket => {

        console.log(
            "Player connected:",
            socket.id
        );


        /* =============================================
           CREATE GAME
        ============================================= */

        socket.on(
            "createGame",
            name => {

                name =
                    String(
                        name || ""
                    )
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

                    host:
                        socket.id,

                    players: [
                        {
                            id:
                                socket.id,

                            name,

                            alive:
                                true,

                            role:
                                null,

                            hasVoted:
                                false
                        }
                    ],

                    phase:
                        "lobby",

                    round:
                        0,

                    nightStep:
                        null,

                    votes:
                        {},

                    nightActions:
                        {},

                    timer:
                        null,

                    timeLeft:
                        0
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


        /* =============================================
           JOIN GAME
        ============================================= */

        socket.on(
            "joinGame",
            data => {

                const code =
                    String(
                        data.code || ""
                    )
                    .trim()
                    .toUpperCase();

                const name =
                    String(
                        data.name || ""
                    )
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

                if (
                    game.phase !== "lobby"
                ) {

                    socket.emit(
                        "errorMessage",
                        "That game has already started."
                    );

                    return;
                }

                if (
                    game.players.length >= 12
                ) {

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

                game.players.push(
                    {
                        id:
                            socket.id,

                        name,

                        alive:
                            true,

                        role:
                            null,

                        hasVoted:
                            false
                    }
                );

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


        /* =============================================
           START GAME
        ============================================= */

        socket.on(
            "startGame",
            code => {

                const game =
                    getGame(code);

                if (!game) return;

                if (
                    game.host !==
                    socket.id
                ) {
                    return;
                }

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


        /* =============================================
           MAFIA
        ============================================= */

        socket.on(
            "mafiaAction",
            data => {

                mafiaAction(
                    socket,
                    data
                );

            }
        );


        /* =============================================
           DOCTOR
        ============================================= */

        socket.on(
            "doctorAction",
            data => {

                doctorAction(
                    socket,
                    data
                );

            }
        );


        /* =============================================
           DETECTIVE
        ============================================= */

        socket.on(
            "detectiveAction",
            data => {

                detectiveAction(
                    socket,
                    data
                );

            }
        );


        /* =============================================
           OLD NIGHT ACTION SUPPORT
        ============================================= */

        socket.on(
            "nightAction",
            data => {

                const game =
                    getGame(
                        data.code
                    );

                if (!game) return;

                if (
                    game.nightStep ===
                    "mafia"
                ) {

                    mafiaAction(
                        socket,
                        data
                    );

                } else if (
                    game.nightStep ===
                    "doctor"
                ) {

                    doctorAction(
                        socket,
                        data
                    );

                } else if (
                    game.nightStep ===
                    "detective"
                ) {

                    detectiveAction(
                        socket,
                        data
                    );

                }

            }
        );


        /* =============================================
           VOTE TARGETS
        ============================================= */

        socket.on(
            "requestVoteTargets",
            code => {

                const game =
                    getGame(code);

                if (!game) return;

                if (
                    game.phase !== "day"
                ) {
                    return;
                }

                const player =
                    getPlayer(
                        game,
                        socket.id
                    );

                if (
                    !player ||
                    !player.alive
                ) {
                    return;
                }

                /*
                   If the player already voted,
                   don't give them new targets.
                */

                if (
                    player.hasVoted
                ) {
                    return;
                }

                socket.emit(
                    "voteTargets",
                    publicPlayers(game)
                );

            }
        );


        /* =============================================
           VOTE
        ============================================= */

        socket.on(
            "vote",
            data => {

                vote(
                    socket,
                    data
                );

            }
        );


        /* =============================================
           CHAT
        ============================================= */

        socket.on(
            "chat",
            data => {

                sendChat(
                    socket,
                    data
                );

            }
        );


        /* =============================================
           DISCONNECT
        ============================================= */

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


                /* LOBBY */

                if (
                    game.phase === "lobby"
                ) {

                    game.players =
                        game.players.filter(
                            p =>
                                p.id !==
                                socket.id
                        );

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

                    if (
                        game.players.length === 0
                    ) {

                        delete games[code];

                        return;
                    }

                    sendPlayers(code);

                    return;
                }


                /* ACTIVE GAME */

                player.alive = false;

                sendSystemMessage(
                    code,
                    `⚠️ ${player.name} disconnected.`
                );

                sendPlayers(code);

                if (
                    game.phase !==
                    "ended"
                ) {

                    checkWinner(code);

                }

            }
        );

    }
);


/* =====================================================
   SERVER START
===================================================== */

server.listen(
    PORT,
    () => {

        console.log(
            `🌎 Global Mafia running on port ${PORT}`
        );

    }
);
