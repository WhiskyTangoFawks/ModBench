using MEditService.Codec.Serialization;
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

    // The Omit customizations are verified no-ops for a standalone Weapon, both targeting only
    // group/Cell/Worldspace fields it does not have.
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

            var roundTripped = (Weapon)await codec.DeserializeAsync(filePath, GameRelease.Fallout4, "weap");

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

    // The dispatch was verified behavior-preserving for Weapon by a manual A/B whose sha256 lived only
    // in a commit message. The golden turns that into a standing gate: regenerate it only after
    // re-verifying the claim.
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

    // A golden compare is structurally blind to non-determinism that reproduces the same wrong output
    // every run. This serializes the same record twice with no golden in the loop, so output depending
    // on wall-clock time shows up here.
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

    // Canonical formatting must not depend on which OS wrote the file. The JSON kernel indents from
    // its private inner TextWriter's NewLine, which the codec cannot configure, so it normalizes after.
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

    // A pre-cancelled token cannot rival this: Serialize checks cancellation before touching any file,
    // so it throws identically under either implementation. /dev/full instead injects a deterministic
    // failure squarely inside the window that differs.
    [Fact]
    public async Task SerializeAsync_WhenTheWriteFailsBeforeTheRename_LeavesThePreexistingFileIntact()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-codec-atomicity-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "weapon.json");
            var originalBytes = "{\"original\":\"content\"}\n"u8.ToArray();
            await File.WriteAllBytesAsync(filePath, originalBytes);

            File.CreateSymbolicLink(filePath + ".tmp", "/dev/full");

            await Assert.ThrowsAnyAsync<IOException>(
                () => codec.SerializeAsync(MakeWeapon(), filePath, GameRelease.Fallout4));

            var survivingBytes = await File.ReadAllBytesAsync(filePath);
            Assert.Equal(originalBytes, survivingBytes);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
