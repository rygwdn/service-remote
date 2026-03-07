# Proclaim Remote Command API Notes

More detail at: https://support.proclaim.logos.com/hc/en-us/articles/19864456647053-Proclaim-App-Command-API

## List of App Commands

The following are the support app commands today. You can see a similar list in Proclaim when setting up MIDI Input.
For commands that require an index, the index is expected to be a value between 1 - 254 and will be annotated with a `*`

## Slide

- `NextSlide`
- `PreviousSlide`
- `NextServiceItem`
- `PreviousServiceItem`
- `StartPreService`
- `StartWarmUp`
- `StartService`
- `StartPostService`
- `GoToServiceItem*`
- `GoToSlide*`

## Audio Video

- `NextAudioItem`
- `PreviousPreviousAudioItem`
- `VideoRestart`
- `VideoRewind`
- `VideoFastForward`
- `VideoPlay`
- `VideoPause`

## QuickScreens

- `ShowBlankQuickScreen`
- `ShowLogoQuickScreen`
- `ShowNoTextQuickScreen`
- `ShowFloatingHeartsQuickScreen`
- `ShowFloatingAmensQuickScreen`
- `ShowAmenQuickScreen`
- `ShowHallelujahQuickScreen`
- `ShowPraiseTheLordQuickScreen`
- `ShowHeIsRisenQuickScreen`
- `ShowHeIsRisenWhiteQuickScreen`

## On/Off Air

- `GoOnAir`
- `GoOffAir`

## Song Commands

For songs, the index is which part of the song it is. So Verse 1 would be 1. Chorus would be 1, Chorus 2 would be 2, etc. For Chorus, Bridge or other un-index values you can ignore the index parameter.

- `ShowSongLyricsVerseByIndex*`
- `ShowSongLyricsBridgeByIndex*`
- `ShowSongLyricsChorusByIndex*`
- `ShowSongLyricsPreChorusByIndex*`
- `ShowSongLyricsEndingByIndex*`
- `ShowSongLyricsInterludeByIndex*`
- `ShowSongLyricsTagByIndex*`
