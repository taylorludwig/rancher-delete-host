import aws         from 'aws-sdk';
import sqsConsumer from 'sqs-consumer';

import Rancher from './util/rancher';

//Configure aws
const autoscaling = new aws.AutoScaling({ apiVersion: '2011-01-01', region: 'eu-west-1' });

//Configure rancher
const rancherServer = new Rancher({
	hostname: 'rancher-server',
	port: 8080,
	accessKey: process.env.RANCHER_SERVER_ACCESS_KEY,
	secretKey: process.env.RANCHER_SERVER_SECRET_KEY
});

//Setup SQS poll
const consumer = sqsConsumer.create({
	queueUrl: process.env.SQS_URL,
	handleMessage: (message, done) => {

		console.log('=> SQS Message received');

		//Attempt to parse the message body (the message should be a json string)
		let messageBody = '';
		try { messageBody = JSON.parse(message.Body); }
		catch (e) {

			//Invalid JSON
			console.log('=> Error: Invalid JSON received, can\'t process this message.');
			return done();

		}

		//Test notification, clear the message from the queue.
		if(messageBody.Event && messageBody.Event == 'autoscaling:TEST_NOTIFICATION') {
			console.log('   Message was a test notification, no further processing required.')
			return done();
		}

		//Instance terminating
		else if(messageBody.LifecycleTransition && messageBody.LifecycleTransition == 'autoscaling:EC2_INSTANCE_TERMINATING') {
			console.log('   Received instance terminating notification.');

			//Setup standard error response
			let errorResponse = function(err) {
				console.log('   Could not remove the host from the rancher server.');
				console.log('   ' + err);
				done();
			}

			//Begin sequence
			//Start by getting the matching hosts from the rancher server
			rancherServer.getHostByIdLabel('HOSTID', messageBody.EC2InstanceId).catch(errorResponse)
			.then((hostIds) => {

				//Check we got a host id. The host id is an array but will
				//only ever return one host id because registered hosts set
				//the unique EC2 instance id as the HOSTID label.
				if(hostIds.length > 0) {

					console.log('   Deactivating host: ' + hostIds[0]);

					//Deactivate the host
					rancherServer.deactivateHost(hostIds[0]).catch(errorResponse)
					.then(() => {

						console.log('   Deleting host: ' + hostIds[0]);

						//Delete the host
						rancherServer.deleteHost(hostIds[0]).catch(errorResponse)
						.then(() => {

							console.log('   Host removed from rancher server.');
							console.log('   Resolving lifecycle hook');

							//Resolve the lifecycle hook
							autoscaling.completeLifecycleAction({
								AutoScalingGroupName:  messageBody.AutoScalingGroupName,
								LifecycleActionToken:  messageBody.LifecycleActionToken,
								LifecycleHookName:     messageBody.LifecycleHookName,
								LifecycleActionResult: 'CONTINUE'
							}, (err, data) => {

								//Notify error (aws will automatically complete the hook after 30 mins)
								if(err) {
									console.log('   Error: could not complete the lifecycle hook (hook will now be completed manually by AWS):');
									console.log(err);
								}

								//Otherwise, we're all done!
								console.log('   Lifecycle hook resolved, all done!');
								done();

							});

						});

					});

				}

				//We didn't find a matching host
				else errorResponse('Host id not found in rancher server.');

			});

		}

		//Anything else
		else {
			console.log('   Unknown message type');
			return done();
		}

	}
});

//Handle errors
consumer.on('error', (err) => {
	console.log('Consumer error, will now exit.');
	console.log(err);
	process.exit(1);
});

//Start receiving messages
consumer.start();
console.log('=> SQS message consumer started, awaiting messages..');

/*

Test notification JSON
{"AutoScalingGroupName":"lifecycle-test","Service":"AWS Auto Scaling","Time":"2015-10-21T13:38:00.143Z","AccountId":"391126026396","Event":"autoscaling:TEST_NOTIFICATION","RequestId":"f20fbb34-77f8-11e5-9842-63a2c2b9270f", "AutoScalingGroupARN":"arn:aws:autoscaling:eu-west-1:391126026396:autoScalingGroup:35f49f32-5a4a-4af1-9273-8ebefc471bd4:autoScalingGroupName/lifecycle-test"}

Terminating JSON
{"AutoScalingGroupName":"lifecycle-test","Service":"AWS Auto Scaling","Time":"2015-10-21T13:40:02.108Z","AccountId":"391126026396","LifecycleTransition":"autoscaling:EC2_INSTANCE_TERMINATING","RequestId":"58a52fc2-7e52-42c1-8d8b-7faebc58e2cb","LifecycleActionToken":"b19b6537-1d99-4c2d-be9f-187e7103d44c","EC2InstanceId":"i-c620877e","LifecycleHookName":"RemoveRancherHost"}

*/


/*

useful bits
http://www.bennadel.com/blog/2792-shedding-the-monolithic-application-with-aws-simple-queue-service-sqs-and-node-js.htm
https://github.com/BBC/sqs-consumer

https://jakearchibald.com/2014/es7-async-functions
https://gist.github.com/patrickarlt/8c56a789e5f185eb9722
https://www.npmjs.com/package/q

https://www.npmjs.com/package/axios


initial message on create hook
{ MessageId: '56ec79c0-99d6-4401-801a-0d6b9e13e70c',
  ReceiptHandle: 'AQEBonEZOjWch7L+ILmlg4M2Upd8S2CFbtzEP03NCWD90feBkyJQgxmbcB0HAcvjlAN5Y8xZ54tsxQf+uxKyxm6TkujBoToK+M3moaCyXUFRPGQTB1wq352oy9IbpbK5NA5p4mZbUSeV53CUVxzTnyl30yhsw3y4VS/m77vFhz1Y+EaYUQVK3e/95NWjIUDkuXRbM2jkHNfdA+2MOjhxmxd6u8iubgquqZ8H3Id8AcHmCUMubetcIaGJdMfYGmOBdPqmpFv8J1vrKzwp/TLeQH6Fny9oswULmazeQ2tC06BlPoWkOGplp+WW108kxnwDHqSUX2RgR+6pEq5oRkKmKgjTLL7ciUOqsx9QLbSsYgaqQU0xe6Z+RXRWGGr8VZFbuKZm',
  MD5OfBody: '5e0cd2abf46d8cce7f83ca3f31674136',
  Body: '{
    "AutoScalingGroupName":"lifecycle-test",
    "Service":"AWS Auto Scaling",
    "Time":"2015-10-21T13:38:00.143Z",
    "AccountId":"391126026396",
    "Event":"autoscaling:TEST_NOTIFICATION",
    "RequestId":"f20fbb34-77f8-11e5-9842-63a2c2b9270f",
    "AutoScalingGroupARN":"arn:aws:autoscaling:eu-west-1:391126026396:autoScalingGroup:35f49f32-5a4a-4af1-9273-8ebefc471bd4:autoScalingGroupName/lifecycle-test"
  }'
}

remove hook
SQS Message received
{ MessageId: '9a4f8e17-8c48-4ac0-a98d-a4918181e6a5',
  ReceiptHandle: 'AQEBvsuVlJ4eXC3kqM3Z/Ob023557Ar07W5ca6VCPQuGgdMHBFpdZQS3umgtQ2yzetbPMqVBxmkP19k8DtyWEMnaDAUKK+AFckwr+xsX+ORq9bmK+/mXM29JRdKEhygJHf9xdFHON5ZpZ+cJb2paHJdgeyuRVGQD4QH84L5pU/T8V5ES5PqCeuKFHgTH+3MR2UGEx3FFU3bJRkcGhl3ZnM58XcrOypZmQGFqepGOz7RbNSMmQP53QTKNK6LHkk+e7uTv1dqSn3i8vV1odqZqkmTsrPTiCBsJ5JzuDU3zNzIP1rdbHH5sWbPRajwxcrvb1/yh+uv/eHsMUQuFCwxt70EAgkdCuxnQQlkoSZERM+KYz9rpLsQQ/EkTcHr/OZdORb7+',
  MD5OfBody: 'fad8289c3a09703fde446ddb7e9d3bdf',
  Body: '{
    "AutoScalingGroupName":"lifecycle-test",
    "Service":"AWS Auto Scaling",
    "Time":"2015-10-21T13:40:02.108Z",
    "AccountId":"391126026396",
    "LifecycleTransition":"autoscaling:EC2_INSTANCE_TERMINATING",
    "RequestId":"58a52fc2-7e52-42c1-8d8b-7faebc58e2cb",
    "LifecycleActionToken":"b19b6537-1d99-4c2d-be9f-187e7103d44c",
    "EC2InstanceId":"i-c620877e",
    "LifecycleHookName":"RemoveRancherHost"
  }'
}

*/