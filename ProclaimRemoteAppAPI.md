# Proclaim Remote App API

Reverse engineering notes about the APIs used by the Proclaim Remote App.

## Status change polling

Long poll that uses

```
GET http://{IP}:52195/onair/statusChanged?localrevision={revision}&step={revision}
ConnectionId: {id}
OnAirSessionId: {id}
Accept: */*
User-Agent: ProclaimLocalRemote/2.15 (iPhone; U; CPU iOS 26.3 like Mac OS X; en_US)
Accept-Language: en-US,en;q=0.9
Connection: keep-alive
```

It takes up to a minute to respond (long poll) and then responds with:

```
{
  "presentationId": "<service guid>",
  "presentationLocalRevision": <localRevision. int, can be bigger than JS int.max>,
  "status": {
    "revision": <int - resend as step>,
    "itemId": "<service item guid>",
    "slideIndex": <int - index into service item>,
    "quickScreenKind": "None",
    "mediaState": "Playing"
  }
}
```
