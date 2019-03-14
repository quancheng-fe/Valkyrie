import 'reflect-metadata'
import { createServer } from '../src'
;(async () => {
  const server = await createServer({
    root: __dirname,
    graphqlServer: {
      playground: true
    }
  })
  server.listen(3144, () => {
    console.log('server started')
  })
})()
