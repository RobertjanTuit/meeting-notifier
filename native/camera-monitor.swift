// Reports macOS camera devices and whether each is actively streaming right now,
// using CoreMediaIO's kCMIODevicePropertyDeviceIsRunningSomewhere. Querying this
// property does not start capture, so it does not require camera permission.
//
// Output: one line per device, tab-separated:  <0|1>\t<device name>
//   1 = currently in use (streaming), 0 = idle.
//
// Build: swiftc -O native/camera-monitor.swift -o bin/camera-monitor

import CoreMediaIO
import Foundation

private func systemObjectID() -> CMIOObjectID {
    return CMIOObjectID(kCMIOObjectSystemObject)
}

private func address(_ selector: Int) -> CMIOObjectPropertyAddress {
    return CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(selector),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
}

private func cameraDevices() -> [CMIOObjectID] {
    var addr = address(Int(kCMIOHardwarePropertyDevices))
    var dataSize: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(systemObjectID(), &addr, 0, nil, &dataSize) == 0,
          dataSize > 0 else { return [] }
    let count = Int(dataSize) / MemoryLayout<CMIOObjectID>.size
    var devices = [CMIOObjectID](repeating: 0, count: count)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(systemObjectID(), &addr, 0, nil, dataSize, &used, &devices) == 0 else { return [] }
    return devices
}

private func deviceName(_ id: CMIOObjectID) -> String {
    var addr = address(Int(kCMIOObjectPropertyName))
    var dataSize: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(id, &addr, 0, nil, &dataSize) == 0 else { return "" }
    var name: Unmanaged<CFString>?
    var used: UInt32 = 0
    let status = CMIOObjectGetPropertyData(id, &addr, 0, nil, dataSize, &used, &name)
    guard status == 0, let cf = name?.takeRetainedValue() else { return "" }
    return cf as String
}

private func isRunning(_ id: CMIOObjectID) -> Bool {
    var addr = address(Int(kCMIODevicePropertyDeviceIsRunningSomewhere))
    var value: UInt32 = 0
    var used: UInt32 = 0
    let status = CMIOObjectGetPropertyData(
        id, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &used, &value
    )
    return status == 0 && value != 0
}

for dev in cameraDevices() {
    let name = deviceName(dev)
    if name.isEmpty { continue }
    print("\(isRunning(dev) ? "1" : "0")\t\(name)")
}
