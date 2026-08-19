using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Serialization;

public class RecordTextCodecTests
{
    private static Weapon MakeWeapon() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), Fallout4Release.Fallout4)
        {
            VersionControl = 12345,
            EditorID = "TestWeapon",
            Name = "Test Weapon Name",
            Value = 250,
            Weight = 12.5f,
            BaseDamage = 42,
            Keywords = [new FormLink<IKeywordGetter>(new FormKey(ModKey.FromFileName("Test.esp"), 0x801))],
            ObjectBounds = new ObjectBounds
            {
                First = new P3Int16(1, 2, 3),
                Second = new P3Int16(4, 5, 6),
            },
        };

    // No exclusion list: verified empirically (#367 report, re-verified for JSON at #412 by
    // temporarily dropping both calls and diffing the regenerated golden fixture byte-for-byte —
    // see RecordTextCodecCustomization's own comment) that .OmitLastModifiedData()/
    // .OmitTimestampData() are no-ops for a standalone Weapon — the serialized JSON is
    // byte-identical with and without them. Both customizations are about mod/header-level
    // metadata (Spriggit's own scope), which this codec never touches; VersionControl (the field
    // that could plausibly be "the timestamp" on a record) round-trips like everything else, which
    // is why this test asserts every field equal with no exceptions.
    //
    // The leaf-count guard is load-bearing, not decoration: Assert.Empty(divergent) alone passes
    // if the walker visits zero leaves (a broken walker, a mask that came back null-shaped, etc.)
    // just as happily as it passes on genuine equality — the same structural blindness
    // BinaryRoundTripGateTests was written to avoid. 81 is the measured leaf count for MakeWeapon();
    // a future Mutagen bump changing that number is itself worth seeing, not just silently accepted.
    [Fact]
    public async Task SerializeAsync_ThenDeserializeAsync_IsFieldFaithful()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeWeapon();
        var dir = Directory.CreateTempSubdirectory("medit-codec-fidelity-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.json");
            await codec.SerializeAsync(original, filePath, GameRelease.Fallout4);

            var roundTripped = (Weapon)await codec.DeserializeAsync(filePath, typeof(Weapon), GameRelease.Fallout4);

            var mask = original.GetEqualsMask(roundTripped);
            var leaves = MaskInspector.CountLeaves(mask).ToList();
            var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

            Assert.Equal(81, leaves.Count);
            Assert.Empty(divergent);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task SerializeAsync_WritesOneFileAtTheGivenPath()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var weapon = MakeWeapon();
        var dir = Directory.CreateTempSubdirectory("medit-codec-layout-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.json");

            await codec.SerializeAsync(weapon, filePath, GameRelease.Fallout4);

            Assert.True(File.Exists(filePath));
            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // Spec review finding 3: #370's generalization of this codec (reflection dispatch by runtime
    // type, replacing #367's hardcoded direct call) was verified behavior-preserving for Weapon by a
    // one-time manual git-stash A/B with a matching sha256 — real, but it lived only in a commit
    // message, so a future change to the dispatch mechanism could silently drift Weapon's output
    // with nothing going red. This is that check turned into a standing gate: the exact text
    // MakeWeapon() produced at that verification is checked in
    // (TestData/weapon-dispatch-golden.json) and compared byte-for-byte on every run. A failure here
    // means the dispatch changed *what* gets produced for a type it was proven not to change, not
    // just *how* it's resolved — regenerate the golden file only after re-verifying that claim, the
    // same way (never by just accepting the new output).
    //
    // #412: this is a *content* pin (key order, field shape, values) — it necessarily proves
    // nothing about whether that content is what the code will keep producing tomorrow, because the
    // golden itself was generated from this same code path. See
    // SerializeAsync_CalledTwiceOnTheSameRecord_ProducesByteIdenticalOutput below for the
    // determinism claim this test structurally cannot make on its own.
    [Fact]
    public async Task SerializeAsync_ForAFixedWeapon_MatchesThePinnedGoldenTextExactly()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-codec-golden-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.json");
            await codec.SerializeAsync(MakeWeapon(), filePath, GameRelease.Fallout4);

            var actual = await File.ReadAllTextAsync(filePath);
            var golden = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));

            Assert.Equal(golden, actual);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // AC4's "identical record state always serializes to identical bytes" claim, proven
    // independently of the golden fixture's own content being correct: a golden-text compare only
    // catches drift from one known-good snapshot, and is structurally blind to non-determinism that
    // reproduces the *same* wrong output on every run of the golden test itself (the exact
    // "round-trip passes trivially when both directions share the same bug" shape flagged for this
    // ticket). This test instead serializes the same in-memory record twice, straight to bytes, with
    // no golden fixture in the loop at all — a defect that made output depend on wall-clock time,
    // object hash-code-ordered dictionary iteration, or any other non-content-driven source would
    // show up here even if the golden fixture happened to be stale or wrong.
    [Fact]
    public async Task SerializeAsync_CalledTwiceOnTheSameRecordState_ProducesByteIdenticalOutput()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-codec-determinism-");
        try
        {
            var firstPath = Path.Combine(dir.FullName, "weapon-first.json");
            var secondPath = Path.Combine(dir.FullName, "weapon-second.json");

            // Two independently-constructed records with the same field values, not the same
            // object serialized twice — closes the gap a single shared instance would leave open
            // (e.g. a serializer that memoizes per-instance and would trivially agree with itself).
            await codec.SerializeAsync(MakeWeapon(), firstPath, GameRelease.Fallout4);
            await codec.SerializeAsync(MakeWeapon(), secondPath, GameRelease.Fallout4);

            var firstBytes = await File.ReadAllBytesAsync(firstPath);
            var secondBytes = await File.ReadAllBytesAsync(secondPath);

            Assert.Equal(firstBytes, secondBytes);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // AC4's cross-platform half: canonical formatting must not depend on which OS wrote the file
    // (#414 pins the git side of the same invariant with core.autocrlf=false at repo init). The
    // JSON kernel's own indentation newlines are sourced from its private inner TextWriter's
    // NewLine, which this codec cannot reach to configure (confirmed by reflection and by
    // decompiling JsonTextWriter.WriteIndent — see RecordTextCodec.SerializeAsync's own comment) —
    // so this codec normalizes after the fact instead. This test is green on arrival on this
    // (Linux) platform regardless of whether that normalization exists, because
    // Environment.NewLine is already "\n" here — see the vacuity note on the mutation-tested rival
    // in the #412 report; a real failure was observed by applying the rival by hand
    // (temporarily reintroducing a raw "\r\n" into the write path) rather than by relying on this
    // assertion alone to prove itself.
    [Fact]
    public async Task SerializeAsync_NeverEmitsACarriageReturn()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-codec-no-cr-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.json");
            await codec.SerializeAsync(MakeWeapon(), filePath, GameRelease.Fallout4);

            var bytes = await File.ReadAllBytesAsync(filePath);

            Assert.DoesNotContain((byte)'\r', bytes);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
