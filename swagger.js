const swaggerAutogen = require('swagger-autogen')()
//const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.3' });
const endpointsFiles = ['./app.js']
const outputFile = './swagger_output.json'
const doc = {
  swagger: '2.0',
  info: { title: 'AI Therapist API', version: '1.0.0' },

  // Bunları placeholder bırakıyoruz; app.js'teki /openapi.json runtime'da host/scheme'i düzeltiyor.
  host: 'DYNAMIC_BY_RUNTIME',
  basePath: '/',
  schemes: ['http', 'https'],

  // File upload + JSON için
  consumes: ['application/json', 'multipart/form-data'],
  produces: ['application/json'],

  // (opsiyonel) securityDefinitions vb. ekleyebilirsin
};
swaggerAutogen(outputFile, endpointsFiles, doc)