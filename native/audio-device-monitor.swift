// Emits a line whenever Core Audio devices are added or removed.
// Output: "changed\t<uid,uid,...>" on stdout (initial snapshot, then each change).
//
// Build: swiftc -O native/audio-device-monitor.swift -o bin/audio-device-monitor -framework CoreAudio

import CoreAudio
import Foundation

private let systemObject = AudioObjectID(kAudioObjectSystemObject)

private func devicesAddress() -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func uid(of id: AudioDeviceID) -> String {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<CFString?>.size)
    var cfUid: Unmanaged<CFString>?
    let status = withUnsafeMutablePointer(to: &cfUid) { ptr in
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
    }
    guard status == noErr, let uid = cfUid?.takeRetainedValue() else { return "id:\(id)" }
    return uid as String
}

private func fingerprint() -> String {
    var addr = devicesAddress()
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &size) == noErr, size > 0 else {
        return ""
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: count)
    var ioSize = size
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &ioSize, &devices) == noErr else {
        return ""
    }
    return devices.map(uid).sorted().joined(separator: ",")
}

private func emit() {
    fputs("changed\t\(fingerprint())\n", stdout)
    fflush(stdout)
}

var addr = devicesAddress()
let status = AudioObjectAddPropertyListenerBlock(
    systemObject,
    &addr,
    DispatchQueue.main
) { _, _ in
    emit()
}

guard status == noErr else {
    fputs("listen-failed \(status)\n", stderr)
    exit(1)
}

emit()
RunLoop.main.run()
