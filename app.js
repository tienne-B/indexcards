import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimiter from 'express-rate-limit';
import uuid from 'uuid/v4.js';
import expressWinston from 'express-winston';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { initialize } from 'express-openapi';
import swaggerUI from 'swagger-ui-express';
import config from './config/config';
import { barfPlease, systemStatus } from './api/controllers/utility/status';

import errorHandler from './api/helpers/error';

import apiDoc from './api/routes/api-doc';

import userPaths from './api/routes/paths/user/index';
import tournPaths from './api/routes/paths/tourn/index';
import autoPaths from './api/routes/paths/auto/index';
import publicPaths from './api/routes/paths/public/index';
import externalPaths from './api/routes/paths/ext/index';

import { auth, tournAuth } from './api/helpers/auth';
import db from './api/helpers/db';

import { debugLogger, requestLogger, errorLogger } from './api/helpers/logger';

const app = express();

// Startup log message
debugLogger.info('Initializing API...');

// Enable Helmet security
app.use(helmet());

// Enable getting forwarded client IP from proxy
app.enable('trust proxy', 1);
app.get('/v1/ip', (request, response) => response.send(request.ip));

// Rate limit all requests
const limiter = rateLimiter({
	windowMs : config.RATE_WINDOW || 15 * 60 * 1000 , // 15 minutes
	max      : config.RATE_MAX || 10000             , // limit each IP to 100000 requests per windowMs
});
app.use(limiter);

const messageLimiter = rateLimiter({
	windowMs : config.MESSAGE_RATE_WINDOW || 15 * 1000 , // 30 seconds
	max      : config.MESSAGE_RATE_MAX || 1            , // limit each to 2 blasts requests per 30 seconds
	message  : `You have reached your rate limit on messages which is ${config.MESSAGE_RATE_MAX} .  Please do not blast people that persistently.`,
});

app.use('/v1/tourn/:tourn_id/round/:round_id/message', messageLimiter);
app.use('/v1/tourn/:tourn_id/round/:round_id/blast', messageLimiter);
app.use('/v1/tourn/:tourn_id/round/:round_id/poke', messageLimiter);

const searchLimiter = rateLimiter({
	windowMs : config.SEARCH_RATE_WINDOW || 30 * 1000 , // 30 seconds
	max      : config.SEARCH_RATE_MAX || 5            , // limit each to 5 search requests per 30 seconds
});

app.use('/v1/public/search', searchLimiter);

// Add a unique UUID to every request, and add the configuration for easy transport
app.use((req, res, next) => {
	req.uuid = uuid();
	req.config = config;
	return next();
});

// Enable CORS
//
const corsOptions = {
	origin : [
		'http://old.dev.tabroom.com',
		'http://old.staging.tabroom.com',
		'https://www.tabroom.com',
	],
	optionsSuccessStatus : 200,
	credentials          : true,
};

app.use('/v1', cors(corsOptions));

// Log all requests
app.use(expressWinston.logger({
	winstonInstance : requestLogger,
	meta            : true,
	env             : process.env.NODE_ENV,
	dynamicMeta: (req, res) => {
		return {
			logCorrelationId: req.uuid,
		};
	},
}));

// Parse body
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ type: ['json', 'application/*json'], limit: '10mb' }));
app.use(bodyParser.text({ type: '*/*', limit: '10mb' }));

if (process.env.NODE_ENV === 'development') {
	// Pretty print JSON in the dev environment
	app.use(bodyParser.json());
	app.set('json spaces', 4);
}

// Parse cookies and add them to the session
app.use(cookieParser());

// Database handle volleyball; don't have to call it in every last route. For I
// am lazy, and unapologetic about being so.

app.use((req, res, next) => {
	req.db = db;
	return next();
});

// Authenticate against Tabroom cookie
app.all('/v1/user/*', async (req, res, next) => {
	req.session = await auth(req, res);
	next();
});

app.all('/v1/tourn/:tourn_id/*', async (req, res, next) => {

	req.session = await auth(req, res);
	req.session = await tournAuth(req, res);

	if (req.session && req.params) {

		if (req.session[req.params.tourn_id]
			&& req.session[req.params.tourn_id].level
		) {
			next();
		} else {
			return res.status(400).json({ message: 'You do not have admin access to that tournament' });
		}

	} else if (req.body?.share_key) {
		next();
	} else {
		return res.status(400).json({ message: 'You are not logged into Tabroom' });
	}

});

const baselinePaths = [
	{ path : '/status', module : systemStatus },
	{ path : '/barf', module   : barfPlease },
];

// Combine the various paths into one
const paths = [
	...autoPaths,
	...baselinePaths,
	...tournPaths,
	...userPaths,
	...publicPaths,
	...externalPaths,
];

// Initialize OpenAPI middleware
const apiDocConfig = initialize({
	app,
	apiDoc,
	paths,
	promiseMode     : true,
	docsPath        : '/docs',
	errorMiddleware : errorHandler,
});

// Log global errors with Winston
app.use(expressWinston.errorLogger({
	winstonInstance : errorLogger,
	meta            : true,
	dynamicMeta: (req, res, next) => {
		return {
			logCorrelationId: req.uuid,
		};
	},
}));

// Final fallback error handling
app.use(errorHandler);

// Swagger UI interface for the API
app.use('/v1/apidoc', swaggerUI.serve, swaggerUI.setup(apiDocConfig.apiDoc));

// Start server
const port = process.env.PORT || config.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
	app.listen(port, () => {
		debugLogger.info(`Server started. Listening on port ${port}`);
	});
}

export default app;
