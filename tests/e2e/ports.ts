// The origin the browser reaches the web app on. The port is configurable so
// the journey can run beside a development server that already holds the
// default one; with nothing set the default is unchanged.
export const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);

export const appOrigin = `http://localhost:${webPort}`;
