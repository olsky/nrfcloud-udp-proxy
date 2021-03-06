import { DeviceConnection, DeviceAppMessage, NetworkInfo } from '../proxy'
import {
	server as WebSocketServer,
	connection as WSConnection,
} from 'websocket'
import { Packet } from 'nmea-simple'
import { handler } from './handler'
import { createHTTPSUiServer } from './https'
import { createHTTPUiServer } from './http'
import { Logger } from 'winston'

export type DeviceGeolocations = Map<string, Packet>

export type DeviceCellGeolocations = Map<
	string,
	Location & {
		ts: string
	}
>

const transformUpdate = {
	TEMP: (data: any) => ({ temp: parseFloat(data) }),
	AIR_QUAL: (data: any) => ({ airQuality: parseFloat(data) }),
	HUMID: (data: any) => ({ humidity: parseFloat(data) }),
	AIR_PRESS: (data: any) => ({ pressure: parseFloat(data) * 10 }),
	RSRP: (data: any) => ({ rsrpDbm: parseFloat(data) }),
} as { [key: string]: (v: any) => object }

const processUpdateUpdate = ({ appId, data }: { appId: string; data: any }) => {
	const t = transformUpdate[appId]
	return t ? t(data) : { appId, data }
}

export type Location = {
	lat: number
	lng: number
	accuracy?: number
}

export const UIServer = async ({
	apiKey,
	httpPort,
	deviceConnections,
	dataDir,
	maintainerEmail,
	logger,
}: {
	apiKey: string
	httpPort: number
	deviceConnections: Map<string, DeviceConnection>
	dataDir: string
	maintainerEmail: string
	logger: Logger
}) => {
	const deviceGeolocations: DeviceGeolocations = new Map()
	const deviceCellGeolocations: DeviceCellGeolocations = new Map()
	const deviceAppStates = new Map<string, { [key: string]: any }>()
	const deviceIMEIs = new Map<string, string>()
	const deviceNetworkInfo = new Map<string, NetworkInfo>()

	const h = handler({
		deviceGeolocations,
		deviceCellGeolocations,
		apiKey,
		deviceConnections,
		deviceAppStates,
		deviceIMEIs,
		deviceNetworkInfo,
	})

	const uiServer =
		httpPort === 443
			? await createHTTPSUiServer({
					handler: h,
					maintainerEmail,
					dataDir,
					logger,
			  })
			: await createHTTPUiServer({ handler: h })

	const wsConnections: WSConnection[] = []

	uiServer.listen(httpPort, () => {
		logger.info(`is listening at 0.0.0.0:${httpPort}`)
		const wsServer = new WebSocketServer({
			httpServer: uiServer,
		})
		wsServer.on('request', request => {
			const connection = request.accept(undefined, request.origin)
			logger.debug(`${connection.remoteAddress} connected`)

			wsConnections.push(connection)
			connection.on('close', () => {
				logger.debug(`${connection.remoteAddress} disconnected`)
				wsConnections.splice(wsConnections.indexOf(connection))
			})
		})
	})

	const updateClients = (update: object) => {
		wsConnections.forEach(connection => {
			logger.debug(`> ${connection.remoteAddress} ${JSON.stringify(update)}`)
			connection.send(JSON.stringify(update))
		})
	}

	return {
		updateDeviceGeoLocation: (
			device: DeviceConnection,
			geolocation: Packet,
		) => {
			deviceGeolocations.set(device.deviceId, geolocation)
			updateClients({
				deviceId: device.deviceId,
				geolocation,
			})
		},
		updateDeviceIMEI: (device: DeviceConnection, imei: string) => {
			deviceIMEIs.set(device.deviceId, imei)
			updateClients({
				deviceId: device.deviceId,
				imei,
			})
		},
		updateDeviceNetworkInfo: (
			device: DeviceConnection,
			networkInfo: NetworkInfo,
		) => {
			deviceNetworkInfo.set(device.deviceId, networkInfo)
			updateClients({
				deviceId: device.deviceId,
				networkInfo,
			})
		},
		updateDeviceCellGeoLocation: (
			device: DeviceConnection,
			cellGeolocation: Location,
			ts?: Date,
		) => {
			const cellGeoWithTs = {
				...cellGeolocation,
				ts: (ts || new Date()).toISOString(),
			}
			deviceCellGeolocations.set(device.deviceId, cellGeoWithTs)
			updateClients({
				deviceId: device.deviceId,
				cellGeolocation: cellGeoWithTs,
			})
		},
		sendDeviceUpdate: (
			device: DeviceConnection,
			update: { update: DeviceAppMessage },
		) => {
			const apps = deviceAppStates.get(device.deviceId) || {}
			const p = processUpdateUpdate(update.update)
			deviceAppStates.set(device.deviceId, {
				...apps,
				...p,
			})
			updateClients({
				deviceId: device.deviceId,
				update: p,
			})
		},
	}
}
