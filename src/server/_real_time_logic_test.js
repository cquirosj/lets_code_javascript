// Copyright (c) 2017 Titanium I.T. LLC. All rights reserved. For license, see "README" or "LICENSE" file.
(function() {
	"use strict";

	const RealTimeLogic = require("./real_time_logic.js");
	const RealTimeServer = require("./real_time_server.js");
	const assert = require("_assert");
	const ClientPointerMessage = require("../shared/client_pointer_message.js");
	const ClientRemovePointerMessage = require("../shared/client_remove_pointer_message.js");
	const ClientClearScreenMessage = require("../shared/client_clear_screen_message.js");
	const ServerRemovePointerMessage = require("../shared/server_remove_pointer_message.js");
	const ServerPointerMessage = require("../shared/server_pointer_message.js");
	const ServerClearScreenMessage = require("../shared/server_clear_screen_message.js");
	const ServerDrawMessage = require("../shared/server_draw_message.js");
	const ClientDrawMessage = require("../shared/client_draw_message.js");
	const Clock = require("./clock.js");

	const IRRELEVANT_MESSAGE = new ClientPointerMessage(42, 24);

	describe("RealTimeLogic", function() {

		let realTimeLogic;
		let realTimeServer;
		let fakeClock;

		beforeEach(function() {
			fakeClock = Clock.createFake();

			realTimeServer = RealTimeServer.createNull();
			realTimeServer.start();
			realTimeLogic = new RealTimeLogic(realTimeServer, fakeClock);
			realTimeLogic.start();
		});

		afterEach(async function() {
			realTimeLogic.stop();
			await realTimeServer.stop();
		});

		it("broadcasts messages from one client to all others", function() {
			const clientId = "client id";
			const clientMessage = new ClientPointerMessage(100, 200);

			realTimeServer.connectNullClient(clientId);
			realTimeServer.simulateClientMessage(clientId, clientMessage);
			assert.deepEqual(realTimeServer.getLastSentMessage(), {
				message: clientMessage.toServerMessage(clientId),
				clientId,
				type: RealTimeServer.SEND_TYPE.ALL_CLIENTS_BUT_ONE
			});
		});

		it("replays all previous messages when client connects", function() {
			const IRRELEVANT_ID = "irrelevant";

			const message1 = new ClientDrawMessage(1, 10, 100, 1000);
			const message2 = new ClientDrawMessage(2, 20, 200, 2000);
			const message3 = new ClientDrawMessage(3, 30, 300, 3000);

			realTimeServer.connectNullClient(IRRELEVANT_ID);
			realTimeServer.simulateClientMessage(IRRELEVANT_ID, message1);
			realTimeServer.simulateClientMessage(IRRELEVANT_ID, message2);
			realTimeServer.simulateClientMessage(IRRELEVANT_ID, message3);

			const serverMessages = trackServerMessages();
			const connectingClient = "connecting client";
			realTimeServer.connectNullClient(connectingClient);

			assert.deepEqual(serverMessages, [
				{ message: message1.toServerMessage(), clientId: connectingClient, type: RealTimeServer.SEND_TYPE.ONE_CLIENT },
				{ message: message2.toServerMessage(), clientId: connectingClient, type: RealTimeServer.SEND_TYPE.ONE_CLIENT },
				{ message: message3.toServerMessage(), clientId: connectingClient, type: RealTimeServer.SEND_TYPE.ONE_CLIENT }
			]);
		});

		it("sends 'remove pointer' message to other browsers when client disconnects", function() {
			let clientId = "my client ID";
			realTimeServer.connectNullClient(clientId);
			realTimeServer.disconnectNullClient(clientId);

			assert.deepEqual(realTimeServer.getLastSentMessage(), {
				message: new ServerRemovePointerMessage(clientId),
				type: RealTimeServer.SEND_TYPE.ALL_CLIENTS
			});
		});

		it("stores 'remove pointer' message in message repo when client disconnects", function() {
			const clientId = "my client ID";

			realTimeServer.connectNullClient(clientId);
			realTimeServer.disconnectNullClient(clientId);
			assert.deepEqual(
				realTimeLogic._messageRepo.replay(),
				[new ServerRemovePointerMessage(clientId)]
			);
		});


		describe("timeout", function() {

			it("times out (removes) ghost pointer when no activity from the client for a period of time", function() {
				const clientId = "my client ID";
				realTimeServer.connectNullClient(clientId);

				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT);
				assert.deepEqual(realTimeServer.getLastSentMessage(), {
					message: new ServerRemovePointerMessage(clientId),
					type: RealTimeServer.SEND_TYPE.ALL_CLIENTS
				});
			});

			it("redisplays ghost pointer when client receives message after timeout", function() {
				const clientId = "my client ID";

				assert.deepEqual(simulateMessageAfterTimeout(new ClientDrawMessage(10, 20, 30, 40)), [
					{
						message: new ServerPointerMessage(clientId, 30, 40),    // should appear in correct location
						type: RealTimeServer.SEND_TYPE.ALL_CLIENTS_BUT_ONE,
						clientId,
					},
					{
						message: new ServerDrawMessage(10, 20, 30, 40),
						type: RealTimeServer.SEND_TYPE.ALL_CLIENTS_BUT_ONE,
						clientId,
					}
				], "SHOULD redisplay ghost pointer after receiving draw message");
				assert.deepEqual(simulateMessageAfterTimeout(new ClientPointerMessage(19, 20)), [
					{
						message: new ServerPointerMessage(clientId, 19, 20),    // should appear in correct location
						type: RealTimeServer.SEND_TYPE.ALL_CLIENTS_BUT_ONE,
						clientId,
					},
				], "SHOULD redisplay ghost pointer after receiving pointer message");
				assert.deepEqual(simulateMessageAfterTimeout(new ClientRemovePointerMessage()), [
					{
						message: new ServerRemovePointerMessage(clientId),
						type: RealTimeServer.SEND_TYPE.ALL_CLIENTS_BUT_ONE,
						clientId,
					},
				], "SHOULD NOT redisplay ghost pointer after receiving remove pointer message");
				assert.deepEqual(simulateMessageAfterTimeout(new ClientClearScreenMessage()), [
					{
						message: new ServerClearScreenMessage(clientId),
						type: RealTimeServer.SEND_TYPE.ALL_CLIENTS_BUT_ONE,
						clientId,
					},
				], "SHOULD NOT redisplay ghost pointer after receiving clear screen message");

				function simulateMessageAfterTimeout(clientMessage) {
					realTimeServer.connectNullClient(clientId);
					fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT);

					const serverMessages = trackServerMessages();
					realTimeServer.simulateClientMessage(clientId, clientMessage);
					return serverMessages;
				}
			});

			it("when sending 'remove pointer' message after timeout, uses the correct client ID", function() {
				let correctId = "correct client ID";
				realTimeServer.connectNullClient(correctId);
				realTimeServer.connectNullClient("different client ID");

				realTimeServer.disconnectNullClient(correctId);

				assert.deepEqual(realTimeServer.getLastSentMessage(), {
					message: new ServerRemovePointerMessage(correctId),
					type: RealTimeServer.SEND_TYPE.ALL_CLIENTS
				});
			});

			it("doesn't time out ghost pointer when any activity has been received from client", function() {
				const clientId = "my client ID";
				const counter = countRemovePointerMessages();

				realTimeServer.connectNullClient(clientId);

				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT / 2);
				realTimeServer.simulateClientMessage(clientId, IRRELEVANT_MESSAGE);
				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT / 2);
				assert.equal(counter.messagesReceived, 0, "should not get any timeout messages");
			});

			it("times out again if there was activity, and then no activity, after the first timeout", function() {
				const clientId = "my client ID";
				const counter = countRemovePointerMessages();

				realTimeServer.connectNullClient(clientId);

				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT);
				assert.equal(counter.messagesReceived, 1, "should have timed out once");

				realTimeServer.simulateClientMessage(clientId, IRRELEVANT_MESSAGE);
				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT);
				assert.equal(counter.messagesReceived, 2, "should time out again after new activity");
				assert.deepEqual(
					realTimeServer.getLastSentMessage().message,
					new ServerRemovePointerMessage(clientId),
					"should time out the correct pointer"
				);
			});

			it("only sends remove pointer message one time when client times out", function() {
				const clientId = "my client ID";
				const counter = countRemovePointerMessages();

				realTimeServer.connectNullClient(clientId);

				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT * 10);
				assert.equal(counter.messagesReceived, 1, "should only time out once");
			});

			it("doesn't time out clients that have disconnected", function() {
				const clientId = "my client ID";
				const counter = countRemovePointerMessages();

				realTimeServer.connectNullClient(clientId);
				realTimeServer.disconnectNullClient(clientId);
				assert.equal(counter.messagesReceived, 1, "should get a disconnect event when disconnecting");

				fakeClock.tick(RealTimeLogic.CLIENT_TIMEOUT);
				assert.deepEqual(counter.messagesReceived, 1, "should not get another disconnect due to timeout");
			});

		});

		function countRemovePointerMessages() {
			const counter = {
				messagesReceived: 0
			};
			realTimeServer.on(RealTimeServer.EVENT.SERVER_MESSAGE, ({ message }) => {
				if (message.name() === ServerRemovePointerMessage.MESSAGE_NAME) counter.messagesReceived++;
			});
			return counter;
		}

		function trackServerMessages() {
			const serverMessages = [];
			realTimeServer.on(RealTimeServer.EVENT.SERVER_MESSAGE, (message) => {
				serverMessages.push(message);
			});
			return serverMessages;
		}

	});

}());