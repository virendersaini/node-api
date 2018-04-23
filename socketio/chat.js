'use strict';

const models = require('../models'),
	notification = require('../controllers/notification'),
	language = require('../controllers/language');

models.chatconsultmessage.belongsTo(models.chatconsult);
models.doctorprofile.hasMany(models.doctorprofiledetail, {
	as: 'doctorprofiledetails',
	foreignKey: 'doctorProfileId',
});

const nothing = () => undefined;

let io;

function sendMessage(message) {
	models.chatconsult.find({
		include: [
			{
				model: models.patient,
				attributes: ['userId'],
			},
			{
				model: models.doctorprofile,
				include: [
					{
						model: models.doctorprofiledetail,
						as: 'doctorprofiledetails',
						where: language.buildLanguageQuery(
							null,
							1,
							'`chatconsult.doctorprofile`.`id`',
							models.doctorprofiledetail,
							'doctorprofileId'
						),
						attributes: ['name'],
					},
				],
				attributes: ['userId'],
			},
		],
		where: {
			id: message.chatconsultId,
		},
		attributes: ['id', 'patientId', 'doctorprofileId'],
	})
	.then(chatconsult => {
		let accessDenied = chatconsult === null || 
			(this.user.user_type === 'doctor' && chatconsult.doctorprofile.userId !== this.user.id) ||
			(this.user.user_type === 'Patient' && chatconsult.patient.userId !== this.user.id);
		if (accessDenied) throw 'ACCESS_DENIED';

		return Promise.all([
			models.chatconsultmessage.create({
				chatconsultId: message.chatconsultId,
				sender: chatconsult.doctorprofile.userId === this.user.id ? 0 : 1,
				status: 1,
				type: message.type,
				data: message.data,
			}),
			models.onlineuser.findAll({
				where: {
					socket: {$ne: this.id},
					userId: this.user.id,
				},
				attributes: ['socket'],
			}),
			models.onlineuser.findAll({
				where: {
					userId: chatconsult.doctorprofile.userId !== this.user.id
						? chatconsult.doctorprofile.userId : chatconsult.patient.userId,
				},
				attributes: ['socket'],
			}),
			chatconsult,
		])
	})
	.then(([chatconsultmessage, senders, receivers, chatconsult]) => {
		let data = chatconsultmessage.toJSON();
		this.emit('message-sent', {
			status: true,
			uid: message.uid,
			id: data.id,
		});
		for (let i = senders.length - 1; i >= 0; i--)
			this.to(senders[i].socket).emit('my-message', data);
		for (let i = receivers.length - 1; i >= 0; i--)
			this.to(receivers[i].socket).emit('message', data);
		if (receivers.length === 0)
			sendNotification(chatconsult, chatconsultmessage, this.user.id);
	})
	.catch(error => this.emit({status: false, error: error}));
}

function messageSeen(messageId, cb = nothing) {
	models.chatconsultmessage.findById(messageId, {
		include: [
			{
				model: models.chatconsult,
				include: [
					{
						model: models.patient,
						attributes: ['userId'],
					},
					{
						model: models.doctorprofile,
						attributes: ['userId'],
					}
				]
			}
		]
	})
	.then(chatconsultmessage => {
		let accessDenied = chatconsultmessage === null ||
			(this.user.user_type === 'Patient' &&
				chatconsultmessage.chatconsult.patient.userId !== this.user.id) ||
			(this.user.user_type === 'doctor' &&
				chatconsultmessage.chatconsult.doctorprofile.userId !== this.user.id);
		if (accessDenied) throw 'ACCESS_DENIED';
		if (chatconsultmessage.status >= 3) return;
		chatconsultmessage.status = 3;
		return chatconsultmessage.save()
		.then(() => models.onlineuser.findAll({
			where: {
				userId: this.user.user_type === 'Patient' ?
					chatconsultmessage.chatconsult.doctorprofile.userId :
					chatconsultmessage.chatconsult.patient.userId
			},
			attributes: ['socket'],
		}))
		.then(onlineusers => {
			for (let i = onlineusers.length - 1; i >= 0; i--) {
				this.to(onlineusers[i].socket).emit('seen', messageId);
			}
		});
	})
	.catch(cb);
}

function messageReceived(messageId, cb = nothing) {
	models.chatconsultmessage.findById(messageId, {
		include: [
			{
				model: models.chatconsult,
				include: [
					{
						model: models.patient,
						attributes: ['userId'],
					},
					{
						model: models.doctorprofile,
						attributes: ['userId'],
					}
				],
				attributes: ['name'],
			}
		]
	})
	.then(chatconsultmessage => {
		let accessDenied = chatconsultmessage === null ||
			(this.user.user_type === 'Patient' &&
				chatconsultmessage.chatconsult.patient.userId !== this.user.id) ||
			(this.user.user_type === 'doctor' &&
				chatconsultmessage.chatconsult.doctorprofile.userId !== this.user.id);
		if (accessDenied) throw 'ACCESS_DENIED';
		if (chatconsultmessage.status >= 2) return;
		chatconsultmessage.status = 2;

		return chatconsultmessage.save()
		.then(() => models.onlineuser.findAll({
			where: {
				userId: this.user.user_type === 'Patient' ?
					chatconsultmessage.chatconsult.doctorprofile.userId :
					chatconsultmessage.chatconsult.patient.userId
			},
			attributes: ['socket'],
		}))
		.then(onlineusers => {
			for (let i = onlineusers.length - 1; i >= 0; i--) {
				this.to(onlineusers[i].socket).emit('received', messageId);
			}
		})
		
	})
	.catch(cb);
}

function getTime(cb) {
	if (! cb) return;
	models.sequelize.query('SELECT CURRENT_TIMESTAMP', {type: models.sequelize.QueryTypes.SELECT})
	.then(results => cb({
		time: Date.parse(results[0].CURRENT_TIMESTAMP),
		status: true
	}))
	.catch(cb);
}

function disconnect() {
	models.onlineuser.destroy({where: {socket: this.id}});
}

function sendNotification(chatconsult, chatconsultmessage, senderId) {
	if (chatconsultmessage.sender === 0) {
		models.patient.find({
			include: [
				{
					model: models.user,
					where: {
						is_notification: 1,
					},
					attributes: ['device_id'],
				}
			],
			where: {
				id: chatconsult.patientId,
			},
			attributes: ['id', 'is_chat_notification'],
		})
		.then(patient => {
			if (patient && patient.user && patient.user.device_id && patient.is_chat_notification)
				notification.sendWithoutSaving(
					[patient.user.device_id],
					'front/notification/chat/message',
					{
						chatconsultmessage,
						senderName: chatconsult.doctorprofile.doctorprofiledetails[0].name,
					},
					{
						data: {
							senderId,
							type: 'chatconsult-message',
						},
						notification: {
							tag: `wikicare-chatconsult-${chatconsult.id}`,
						},
						collapse_key: `wikicare-chatconsult-${chatconsult.id}`,
					}
				)
				.then(console.log)
				.catch(console.log);
		});
	} else {
		models.doctorprofile.find({
			include: [
				{
					model: models.user,
					where: {
						is_notification: 1,
					},
					attributes: ['device_id'],
				},
				{
					model: models.onlineconsultsetting,
					where: {
						available_for_consult: 1,
						consultation_fee: {$ne: null},
						chat_notification: 1,
					},
					attributes: [],
				},
			],
			where: {
				id: chatconsult.doctorprofileId,
			},
		})
		.then(doctorprofile => {
			if (doctorprofile && doctorprofile.user && doctorprofile.user.device_id)
				notification.sendWithoutSaving(
					[doctorprofile.user.device_id],
					'front/notification/chat/message',
					{
						chatconsultmessage,
						senderName: chatconsult.name,
					},
					{
						data: {
							senderId,
							type: 'chatconsult-message',
						},
						notification: {
							tag: `wikicare-chatconsult-${chatconsult.id}`,
						},
						collapse_key: `wikicare-chatconsult-${chatconsult.id}`,
					}
				)
				.then(console.log)
				.catch(console.log);
		})
	}
}

module.exports = function (_io) {
	io = _io;
	return function (socket) {
		if (! socket.user) return;
		models.onlineuser.create({
			userId: socket.user.id,
			socket: socket.id
		})
		.then(() => {
			socket.on('send-message', sendMessage);
			socket.on('seen', messageSeen);
			socket.on('received', messageReceived);
			socket.on('get-time', getTime);
			socket.on('disconnect', disconnect);
		});
	};
}
