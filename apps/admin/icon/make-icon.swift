// Draws Broadsheet Admin's app icon: the reader's "B" (taken from its icon, so the two match) as the masthead of a
// front page, on the reader's navy, in the shape of a macOS app icon. Writes AppIcon.icns next to this file.
//   swift apps/admin/icon/make-icon.swift            (build.sh copies the .icns into the app)
import AppKit
import CoreGraphics

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let readerIcon = here.appendingPathComponent("../../reader/public/icon-512.png").standardizedFileURL

// ---- Colours (the reader's: --accent, --paper, --rule) -------------------------------------------------------------
func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}
let navy = rgb(0x1d2a44), navyLight = rgb(0x2c3f66), navyDark = rgb(0x141d31)
let paper = rgb(0xf7f4ee), paperBack = rgb(0xe6dfd1), ink = rgb(0x1d2a44), textLine = rgb(0xbcb4a6), photo = rgb(0xc9d3e6)

// ---- The B: the white pixels of the reader's icon, as one row-run path in a 0...1 box (y up) ------------------------
func letterB() -> (path: CGPath, aspect: CGFloat) {
    guard let rep = NSImage(contentsOf: readerIcon).flatMap({ NSBitmapImageRep(data: $0.tiffRepresentation!) }) else {
        fatalError("Can't read \(readerIcon.path)")
    }
    let w = rep.pixelsWide, h = rep.pixelsHigh
    func white(_ x: Int, _ y: Int) -> Bool { (rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)?.brightnessComponent ?? 0) > 0.6 }
    var minX = w, maxX = 0, minY = h, maxY = 0
    for y in 0..<h { for x in 0..<w where white(x, y) { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } }
    let bw = CGFloat(maxX - minX + 1), bh = CGFloat(maxY - minY + 1)
    let path = CGMutablePath()
    for y in minY...maxY {
        var x = minX
        while x <= maxX {
            guard white(x, y) else { x += 1; continue }
            let start = x
            while x <= maxX && white(x, y) { x += 1 }
            // Image rows go down; ours go up. A hair of overlap between rows avoids hairline seams.
            path.addRect(CGRect(x: CGFloat(start - minX) / bw, y: 1 - CGFloat(y - minY + 1) / bh, width: CGFloat(x - start) / bw, height: 1.02 / bh))
        }
    }
    return (path, bw / bh)
}
let B = letterB()

// ---- Drawing, on a 1024 × 1024 canvas ------------------------------------------------------------------------------
func drawIcon(_ c: CGContext) {
    // The app-icon shape (Apple's grid: an 824-point rounded square, centred) with a soft shadow.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: rgb(0x000000, 0.35))
    c.addPath(shape); c.setFillColor(navy); c.fillPath()
    c.restoreGState()
    c.saveGState()
    c.addPath(shape); c.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [navyLight, navyDark] as CFArray, locations: [0, 1])!
    c.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

    // A second sheet behind, turned the other way, so it reads as a newspaper rather than a card.
    let page = CGSize(width: 540, height: 640)
    func sheet(angle: CGFloat, offset: CGPoint, fill: CGColor, draw: ((CGContext) -> Void)? = nil) {
        c.saveGState()
        c.translateBy(x: 512 + offset.x, y: 500 + offset.y)
        c.rotate(by: angle * .pi / 180)
        c.translateBy(x: -page.width / 2, y: -page.height / 2)
        c.setShadow(offset: CGSize(width: 0, height: -8), blur: 22, color: rgb(0x000000, 0.4))
        c.setFillColor(fill); c.fill(CGRect(origin: .zero, size: page))
        c.setShadow(offset: .zero, blur: 0, color: nil)
        draw?(c)
        c.restoreGState()
    }
    sheet(angle: 6, offset: CGPoint(x: 22, y: 6), fill: paperBack)
    sheet(angle: -4, offset: .zero, fill: paper) { c in
        // Masthead: the B, with a small boxed "ear" on each side, as front pages have.
        let bh: CGFloat = 250, bw = bh * B.aspect
        let bRect = CGRect(x: (page.width - bw) / 2, y: page.height - 44 - bh, width: bw, height: bh)
        c.saveGState()
        c.translateBy(x: bRect.minX, y: bRect.minY); c.scaleBy(x: bw, y: bh)
        c.addPath(B.path); c.setFillColor(ink); c.fillPath()
        c.restoreGState()
        for x in [CGFloat(40), page.width - 40 - 104] {
            let ear = CGRect(x: x, y: bRect.midY - 44, width: 104, height: 88)
            c.setStrokeColor(textLine); c.setLineWidth(4); c.stroke(ear.insetBy(dx: 2, dy: 2))
            for i in 0..<3 { c.setFillColor(textLine); c.fill(CGRect(x: ear.minX + 16, y: ear.maxY - 28 - CGFloat(i) * 20, width: i == 2 ? 46 : 72, height: 9)) }
        }
        // The double rule under the masthead.
        let ruleY = bRect.minY - 26
        c.setFillColor(ink)
        c.fill(CGRect(x: 40, y: ruleY, width: page.width - 80, height: 9))
        c.fill(CGRect(x: 40, y: ruleY - 13, width: page.width - 80, height: 3))
        // Three columns of text; a photo at the top of the first.
        let top = ruleY - 34, bottom: CGFloat = 40, gutter: CGFloat = 22
        let colW = (page.width - 80 - 2 * gutter) / 3
        for col in 0..<3 {
            let x = 40 + CGFloat(col) * (colW + gutter)
            var y = top
            if col == 0 {
                c.setFillColor(photo); c.fill(CGRect(x: x, y: y - 96, width: colW, height: 96)); y -= 96 + 22
            }
            var line = 0
            while y - 10 >= bottom {
                let short = line % 5 == 4
                c.setFillColor(textLine); c.fill(CGRect(x: x, y: y - 10, width: short ? colW * 0.55 : colW, height: 10))
                y -= short ? 34 : 21
                line += 1
            }
        }
    }
    c.restoreGState()
}

// ---- Render, then the .iconset sizes, then the .icns ---------------------------------------------------------------
func render(_ size: Int) -> CGImage {
    let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    c.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    drawIcon(c)
    return c.makeImage()!
}
func writePNG(_ image: CGImage, _ url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("Couldn't write \(url.path)") }
}

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon-\(getpid()).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    writePNG(render(points), iconset.appendingPathComponent("icon_\(points)x\(points).png"))
    writePNG(render(points * 2), iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
let icns = here.appendingPathComponent("AppIcon.icns")
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try p.run(); p.waitUntilExit()
guard p.terminationStatus == 0 else { fatalError("iconutil failed") }
if let preview = CommandLine.arguments.dropFirst().first { writePNG(render(1024), URL(fileURLWithPath: preview)) }
try? FileManager.default.removeItem(at: iconset)
print("Wrote \(icns.path)")
