## Meter requests
The /meters OSC command is used for obtaining Meter data, or to get a specific set of meter values. Update
cycle frequency for meter data is 50 ms, and may be variable according to console’s ability to fulfill requests.
Timeout is 10 seconds.
Meter values are returned as floats in the range [0.0, 1.0], representing the linear audio level (digital 0 – full‐scale;
internal headroom allows for values up to 8.0 (+18 dBfs)).
The typical format for /meters is as follows:
/meters ,siii <meter request and parameters (see below)> [time_factor]
The highlighted sii tags are used for the meter request, comprising a string and two ints depending on the meter
request type. The command is active for about 10s. Possible meter requests are given in the following pages. The
last int of the command is used to control the number of times the requestor will receive meter values.
time_factor is a value between 1 and 99 setting the interval between two successive meters messages to
50ms * time_factor. Any value of time_factor outside or [1, 99] is equivalent to 1. For a timespan of 10s, the
number of updates can be calculated based on the value of time_factor as below:
time_factor: <2 or >99  200 updates
2  100 updates
[…]
40  5 updates
80 to 99  3 updates
The data returned by the X32/M32 server for /meters is an OSC‐blob, an abitrary set of binary data. As a result,
the format differs from what is typically returned by the X32/M32. This is essentially for efficiency/performance
reasons. The format of a returned blob is as follows:
<meter id> ,b~~<int1><int2><nativefloat>…<nativefloat>
<meter id>: ,b~~: <int1>: <int2>: <nativefloat>: see possible values below (padded with null bytes)
indicates a blob format, padded with null bytes
the length of the blob in bytes, 32 bits big‐endian coded
the number of <nativefloats>, 32 bits little‐endian coded
data or meter value(s), 32 bits floats, little‐endian coded
Example:
The following meter request is sent to an X32/M32 server:
/meters~,si~/meters/6~~~16
Where ~ stands for null character, and “16” is actually sent as a big‐endian 32bit integer, i.e. 0x00000010.
2f6d6574657273002c7369002f6d65746572732f3600000000000010
/ m e t e r s ~ , s i ~ / m e t e r s / 6 ~ ~ ~[ 16]
The X32/M32 server will returns for 10 seconds and approximately every 50ms the 4 channel strip meters (pre‐
fade, gate, dyn gain reduction and post‐fade) values of channel 17, in a single blob, as shown in the reply message
below:
2f6d65746572732f360000002c6200000000001404000000fd1d2137fdff7f3f0000803f6ebbd534
/ m e t e r s / 6 ~ ~ ~ , b ~ ~[ int1 ][ int2 ][nfloat][nfloat][nfloat][nfloat]
Unofficial X32/M32 OSC Remote Protocol 16 Patrick‐Gilles Maillot
List of all Meter IDs:
/meters/0
Returns meter values from the METERS page (not used for X32‐Edit):
32 input channels
8 aux returns
4x2 st fx returns
16 bus masters
6 matrixes
 returns 70 float values as single binary blob
/meters/1
Returns meter values from the METERS/channel page:
32 input channels
32 gate gain reductions
32 dynamics gain reductions
 returns 96 float values as a single OSC blob
/meters/2
Returns meter values from the METERS/mix bus page:
16 bus masters
6 matrixes
2 main LR
1 mono M/C
16 bus master dynamics gain reductions
6 matrix dynamics gain reductions
1 main LR dynamics gain reduction
1 mono M/C dynamics gain reduction
 returns 49 float values as a single OSC blob
/meters/3
Returns meter values from the METERS/aux/fx page:
6 aux sends
8 aux returns
4x2 st fx returns
 returns 22 float values as a single OSC blob
/meters/4
Returns meter values from the METERS/in/out page:
32 input channels
8 aux returns
16 outputs
16 P16 ultranet outputs
6 aux sends
2 digital AES/EBU out
2 monitor outputs
 returns 82 float values as a single OSC blob
Unofficial X32/M32 OSC Remote Protocol 17 Patrick‐Gilles Maillot
/meters/5 <chn_
meter
_id> <grp_
meter
id>
_
Returns meter values the Console Surface VU Meters (channel, group and main meters):
16 channel meters: <chn_meter_id> 0: channel 1‐16; 1: channel 17‐32; 2: aux/fx returns;
3: bus masters
8 group meters: <grp_meter_id> 1: mix bus 1‐8; 2: mix bus 9‐16; 3: matrixes
2 main LR
1 mono M/C
 returns 27 float values as a single OSC blob
/meters/6 <channel_
id>
Returns meter values from Channel Strip Meters (post gain/trim, gate, dyn gain reduction and post‐fade):
4 channel strip meters: <channel_id> channel 0…71]

returns 4 float values a as single OSC blob
/meters/7
Returns meter values from the Bus Send meters:
16 bus send meters
 returns 16 float values (from Bus sends 1‐16) as a single OSC blob
/meters/8
Returns meter values from Matrix Send meters:
6 Matrix send meters
 returns 6 float values (from Matrix sends 1‐6) as a single OSC blob
/meters/9
Returns meter values from Effect Send and Return meters:
2 effects send and 2 effects return meters for each FX slot (8 slots)
 returns 32 float values (4 x FX1, 4 x FX2, … 4 x FX8) as a single OSC blob
/meters/10
Used for some Effects, for example Dual DeEsser, Stereo DeEsser, Stereo Fair Compressor
 returns 32 float values
/meters/11
Returns meter values from the Monitor pages
 returns 5 float values (Mon Left, Mon Right, Talk A/B level, Threshold/GR, Osc Tone level) as a single OSC
blob
/meters/12
Returns meter values from the Recorder page
 returns 4 float values (RecInput L, RecInput R, Playback L, Playback R) as a single OSC blob
/meters/13
Returns meter values from the METERS page
32 input channels
8 aux returns
4x2 st fx returns
 returns 48 float values
