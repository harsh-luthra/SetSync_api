import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import './config/firebase'; // initialize FCM (or log that push is disabled)
import { logger } from './config/logger';
import { startJobs } from './jobs';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import actorCallsRouter from './routes/actorCalls';
import actorsRouter from './routes/actors';
import attendanceRouter from './routes/attendance';
import callsheetRouter from './routes/callsheet';
import costumesRouter from './routes/costumes';
import jobsRouter from './routes/jobs';
import notificationsRouter from './routes/notifications';
import masterRouter from './routes/master';
import projectsRouter from './routes/projects';
import propsRouter from './routes/props';
import scenesRouter from './routes/scenes';
import scriptRouter from './routes/script';
import shootdaysRouter from './routes/shootdays';
import usersRouter from './routes/users';
import walkieRouter from './routes/walkie';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/health' },
    // Never write credentials into logs
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-cron-secret"]',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'setsync-api' }));

const api = express.Router();
api.use(usersRouter); // /auth/bootstrap, /users/*, /crew*
api.use(actorsRouter); // /actors/me/*, /print-requests/*
api.use('/master', masterRouter);
api.use('/projects', projectsRouter);
api.use('/shootdays', shootdaysRouter);
api.use('/scenes', scenesRouter);
api.use('/actor-calls', actorCallsRouter);
api.use('/costumes', costumesRouter);
api.use('/props', propsRouter);
api.use('/walkie', walkieRouter);
api.use('/attendance', attendanceRouter);
api.use('/script', scriptRouter);
api.use('/callsheet', callsheetRouter);
api.use('/notifications', notificationsRouter);
api.use('/jobs', jobsRouter);
app.use('/api/v1', api);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info(`SetSync API listening on :${env.PORT} (${env.NODE_ENV})`);
  startJobs();
});
