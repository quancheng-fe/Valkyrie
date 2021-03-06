/* eslint-disable @typescript-eslint/no-explicit-any */
import { join } from 'path'
import grpc, { credentials } from 'grpc'
import { readFileSync } from 'fs-extra'
import Container from 'typedi'
import BPromise from 'bluebird'
import { Eureka } from 'eureka-js-client'
import ip from 'ip'
import { sample } from 'lodash'
import { Logger } from 'pino'
import { captureException } from '@sentry/core'
import { NodeBaseConfig } from './loadConfig'
import { ServerOptions } from '../server'

const pem = readFileSync(join(__dirname, '../../resource/server.pem'))

interface GrpcClientClassOptions {
  name: string
  credentialsExternal?: typeof credentials
}

let eurekaClient: Eureka

const DEFAULT_OPTIONS = {
  'grpc.ssl_target_name_override': 'grpc',
  'grpc.default_authority': 'grpc',
  'grpc.max_send_message_length': 8 * 1024 * 1024,
  'grpc.max_receive_message_length': 8 * 1024 * 1024
}

const getHost = (option: GrpcClientClassOptions) => {
  const nameArr = option.name.split('/')
  const appId = nameArr[nameArr.length - 1]
  const instances = eurekaClient.getInstancesByAppId(appId)
  const randomInstance = sample(instances)
  return {
    packageName: nameArr[0],
    host: `${randomInstance.ipAddr}:${(randomInstance.port as any).$ + 1}`
  }
}

type createGrpcClientType = ((
  Client: any,
  option?: GrpcClientClassOptions
) => any) & { logger?: Logger }

const createGrpcClient: createGrpcClientType = (Client, option) => {
  const sslCreds = (option.credentialsExternal || credentials).createSsl(pem)
  if (Client.create) {
    const ClientConstructor = (grpc as any).makeGenericClientConstructor({})
    return Client.create((method: any, requestData: any, callback: any) => {
      const { packageName, host } = getHost(option)
      const client = new ClientConstructor(host, sslCreds, DEFAULT_OPTIONS)
      ;(client as any).makeUnaryRequest(
        `/${packageName}/${method.name}`,
        (argument: any) => argument,
        (argument: any) => argument,
        requestData,
        new grpc.Metadata(),
        (...args: any[]) => {
          if (args[0]) {
            ;(createGrpcClient.logger || console).error(args[0])
          }
          callback.apply(null, args)
        }
      )
    })
  }
  const client = new Client(getHost(option).host, sslCreds, DEFAULT_OPTIONS)
  return BPromise.promisifyAll(client)
}

export const InjectGrpcService = (
  Client: any,
  option?: GrpcClientClassOptions
): Function => (
  target: Record<string, any>,
  propertyName: string,
  index?: number
): any => {
  Container.registerHandler({
    object: target,
    propertyName: propertyName,
    index: index,
    value: () => {
      try {
        return createGrpcClient(Client, option)
      } catch (e) {
        captureException(e)
        return null
      }
    }
  })
}

export const setupEureka = (
  config: ServerOptions & NodeBaseConfig,
  logger?: Logger
): Promise<Eureka> => {
  createGrpcClient.logger = logger
  return new Promise((resolve, reject) => {
    eurekaClient = new Eureka({
      logger,
      instance: {
        app: `${config.name}${
          process.env.NODE_ENV !== 'production' ? ':dev' : ''
        }`,
        hostName: ip.address(),
        ipAddr: ip.address(),
        port: {
          $: process.env.PORT || 8881,
          '@enabled': 'true'
        },
        vipAddress: `${config.name}.nodejs`,
        dataCenterInfo: {
          '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
          name: 'MyOwn'
        }
      },
      eureka: {
        serviceUrls: {
          default: config.eureka.split(',')
        },
        heartbeatInterval: 5000,
        registryFetchInterval: 1000,
        shouldUseDelta: true
      }
    } as any)

    eurekaClient.start(err => {
      if (err) reject(err)
      resolve(eurekaClient)
    })
  })
}
