const swaggerAutogen = require('swagger-autogen')()
//const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.3' });
const endpointsFiles = ['./app.js']
const outputFile = './swagger_output.json'
const doc = { info: { title: 'AI Therapist API', version: '1.0.0' } };
swaggerAutogen(outputFile, endpointsFiles, doc)