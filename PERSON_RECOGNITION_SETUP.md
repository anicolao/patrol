# Person Recognition Setup

Patrol's first person recognition pass uses the Annke camera-side person event as
the trigger. The `patrol-person-recognizer` worker then:

1. Replays camera events and finds active Annke person alerts.
2. Waits for a retained main-stream recording segment that overlaps the event.
3. Extracts a high-resolution still frame and a prior comparison frame from
   that segment with `ffmpeg`.
4. Crops the target rectangle when the camera XML includes one; otherwise it
   computes a motion mask between the comparison frame and event frame, rejects
   timestamp/watermark and edge noise, crops the best person-sized motion
   component from the high-resolution frame, and validates the crop with Apple
   person segmentation before generating a feature vector.
5. Runs an Apple Vision feature-print helper compiled from
   `scripts/person-featureprint.swift`.
6. Appends `person.recognition.sample.analyzed` or
   `person.recognition.sample.failed` events.

The model is label-driven. The UI appends `person.recognition.sample.labeled`
when a user names a sample. Reducers build label centroids from Apple Vision
feature vectors and immediately propose labels for remaining unlabeled samples.
No mutable training database is required; replaying the event log rebuilds the
same recognition state.

Start the worker from the Nix shell:

```sh
nix develop -c patrol-person-recognizer
```

The worker requires macOS with Apple Vision available through Xcode command line
tools. It compiles the Swift helper into `.patrol/bin/` on first start.

If neither the camera XML nor the high-resolution motion cropper produces a
plausible person crop, Patrol emits `person.recognition.sample.failed` instead
of training against a full frame. Crop attempts include a `cropVersion` in the
event payload so improved crop logic can supersede older bad samples through
normal event replay.

Generated crops live under:

```text
.patrol/person-recognition/crops/
```

They are served to the UI through `/api/person-recognition/crops?path=...`.
