var aws        = require('aws-sdk');
var bodyParser = require('body-parser');
var express    = require('express');
var request    = require('request');

//Actions
var confirmSubscription = require('./actions/confirmSubscription');
var handleNotifcation   = require('./actions/handleNotifcation');

//////////////////////////////
// Ensure required env vars //
//////////////////////////////

var config = {};

//App port
config.port = process.env.PORT || null;

if(!config.port) {
	console.log('Missing port.');
    return process.exit(1);
}

//Rancher server access keys
config.accessKey = process.env.RANCHER_SERVER_ACCESS_KEY || null;
config.secretKey = process.env.RANCHER_SERVER_SECRET_KEY || null;

if(!config.accessKey || !config.secretKey) {
    console.log('Missing key or secret.');
    return process.exit(1);
}

// Delete host / route
config.deleteHost  = process.env.DELETE_HOST || null;
config.deleteRoute = process.env.DELETE_ROUTE || null;

if(!config.deleteHost || !config.deleteRoute) {
	console.log('Missing delete host or route.');
	return process.exit(1);
}

//ASG lifecycle sns topic arn
config.asgTopicArn  = process.env.ASG_HOOK_TOPIC_ARN || null;

if(!config.asgTopicArn) {
	console.log('Missing ASG topic ARN.');
	return process.exit(1);
}

//Build the rancher server url
config.rancherUrl = 'http://' + config.accessKey + ':' + config.secretKey + '@rancher-server:8080/v1';

///////////////
// Setup AWS //
///////////////

var sns = new aws.SNS({ apiVersion: '2010-03-31', region: 'eu-west-1' });

////////////////////////
// Create express app //
////////////////////////

var app = express();
app.use(bodyParser.json({
	type: '*/*'
}));

//Handle ping request. This is used to make sure
//the server is up and routeable before starting
//sns config.
app.get(config.deleteRoute, function (req, res) {
	res.status(200).json({ up: true });
});

//Handle delete host requests
//This handler receives an asg lifecycle hook. All the data is in
//the request body. It contains info about the instance.
app.post(config.deleteRoute, function (req, res) {

	//Inspect headers for the "x-amz-sns-message-type" value
	if(!req.headers['x-amz-sns-message-type']) {
		return res.status(404).send('Unknown message');
	}

	//Handle either the confirmation or a notification
	switch(req.headers['x-amz-sns-message-type']) {

		//Make a request back to SNS to confirm the subscription
		case 'SubscriptionConfirmation':
			confirmSubscription(req, res, sns);
			break;

		//Handle notifications
		case 'Notification':
			handleNotifcation(req, res, config);
			break;

		//Send an error for all other types
		default:
			return res.status(404).send('Not handled - must be SubscriptionConfirmation or Notification');
			break;

	}

});

//Start server
var server = app.listen(config.port, function () {
	console.log('=> Rancher host delete started.');
});

//////////////////////
// SNS subscription //
//////////////////////

/**
 * After the server has started, ensure it is subscribed to the
 * target autoscaling SNS topic.
 */

var ping = setInterval(function() {
	console.log('=> Checking asg host status (http://'+ (config.deleteHost + config.deleteRoute) +')');
	request({
		method: 'GET',
		url: 'http://' + config.deleteHost + config.deleteRoute,
		timeout: 5000
	}, function(err, response, body) {

		if(err) {
			console.log('   Error checking asg handler status.');
			console.log(err);
			/*clearInterval(ping);
			return process.exit(1);*/
		}

		//Up?
		if(body && JSON.parse(body).up) {
			clearInterval(ping);
			console.log('   Server available.');
			verifySnsSubscription();
		}

	});
}, 5000);

/**
 * Function to verify and if necessary subscribe
 * to the target asg notification sns topic.
 */

var verifySnsSubscription = function () {

	console.log('=> Checking current host asg topic subscription status');

	sns.listSubscriptionsByTopic({ TopicArn: config.asgTopicArn }, function(err, data) {

		//Handle error
		if(err) {
			console.log('   Error: could not read initial topic subscriptions.');
			console.log(err);
			return process.exit(1);
		}

		var endpointSubscribed = false;
		data.Subscriptions.forEach(function(sub) {
			
			if(sub.Endpoint == ('http://' + config.deleteHost + config.deleteRoute) && sub.SubscriptionArn != 'PendingConfirmation') {
				endpointSubscribed = true;
			}

			//Unsubscribe any other endpoints
			else if(sub.SubscriptionArn != 'PendingConfirmation') {
				console.log('   - Unsubscribing: ' + sub.Endpoint);
				sns.unsubscribe({ SubscriptionArn: sub.SubscriptionArn }, function(err, data) {
					if(err) console.log(err, err.stack);
					else    console.log(data);
				});
			}

		});

		console.log('   Current host subscribed: ' + (endpointSubscribed ? 'yes' : 'no'));

		//If the current host isnt subscribed, subscribe it
		if(!endpointSubscribed) {
			
			console.log('   Attemping subscription..');

			var params = {
				Protocol: 'http',
				TopicArn: config.asgTopicArn,
				Endpoint: 'http://' + config.deleteHost + config.deleteRoute
			};
			sns.subscribe(params, function(err, subscrData) {

				//Handle error
				if(err) {
					console.log('   Error: Could not subscribe to topic.');
					console.log(err);
					return process.exit(1);
				}

				//Ok
				console.log('   Successfully initiated topic subscription.');
				return;

			});

		}

	});

};
