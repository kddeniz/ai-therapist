const swaggerAutogen = require('swagger-autogen')()
const endpointsFiles = ['./app.js']
const outputFile = './swagger_output.json'
const doc = { info: { title: 'AI Therapist API', version: '1.0.0' } };
swaggerAutogen(outputFile, endpointsFiles, doc)