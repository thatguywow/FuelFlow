# Privacy Policy

**FuelFlow** · last updated 17 August 2026

## The short version

FuelFlow does not collect anything. There is no account, no server of ours, and
no analytics. Everything you log stays in the app's own storage on your device.

That is not a promise about how carefully we handle your data — it is a
statement that we never receive it.

## What is stored, and where

Everything below is written to the app's private storage on your device
(IndexedDB inside the app's WebView) and nowhere else:

- your diary entries, meals and recipes
- your profile: height, weight, age, reference sex, activity level, goals
- weigh-ins and body measurements
- water and exercise entries
- foods you create, and a cache of foods looked up from public databases
- your settings

Uninstalling the app deletes all of it. We cannot recover it, because we never
had it.

## What leaves your device

Three things, and only when you use the feature that needs them:

**Food database downloads.** On first launch the app downloads a bundled dataset
of generic foods, and it reads a hosted database of packaged products over the
network as you search. These are ordinary file downloads. They tell the server
which food data was requested, and nothing about you.

**Open Food Facts lookups.** When you search for a packaged product or scan a
barcode that is not already on your device, the app queries
[Open Food Facts](https://world.openfoodfacts.org), a public, non-profit food
database. The request contains the search text or the barcode, plus an
identifier for the app itself. It contains no identifier for you. Open Food
Facts' own privacy policy applies to that request.

**Backups you export.** If you export a backup or a CSV, the file goes wherever
you send it. That is under your control, and the app offers to encrypt the
backup with a passphrase before it is written.

Nothing else is transmitted. There is no telemetry, no crash reporting, no
advertising identifier, and no third-party SDK that collects data.

## Permissions

**Camera** — used only while a scanner screen is open, to read a barcode or a
nutrition label. Frames are processed on your device and are not stored or
transmitted. The app does not request photo library access.

The app requests no location, contacts, microphone or health-platform
permissions.

## Children

FuelFlow is not directed at children under 13 and collects no data from anyone,
including children.

## Changes

If this policy ever changes, the new version will be published here and the
date above updated. Because the app collects nothing, a change would mean the
app started doing something new — which would be described plainly.

## Contact

FuelFlow is free software, developed in the open at
<https://github.com/thatguywow/FuelFlow>. Questions and concerns are best raised
as an issue there.
