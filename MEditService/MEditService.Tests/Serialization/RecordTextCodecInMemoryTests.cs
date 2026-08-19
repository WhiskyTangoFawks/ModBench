using MEditService.Core.Serialization;
using MEditService.Tests.RealData;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #413 slice S1: the codec's in-memory path. Indexing produces a document for every record in the
/// load order — millions of them — so it needs the codec's bytes without a filesystem round trip;
/// #411's probe had to duplicate this path privately to measure at all.
///
/// The bytes must be <b>the ledger file's bytes</b>, not merely similar: ADR-0041 makes the stored
/// document byte-identical to what the ledger holds, which is what lets a byte compare stand in for
/// dirty/ITM/revert-convergence detection later in the arc. So the in-memory path is asserted
/// against the committed golden text — an independent, reviewed artifact — and against what
/// <see cref="RecordTextCodec.SerializeAsync"/> actually writes for a dense real record, rather than
/// against itself.
/// </summary>
public class RecordTextCodecInMemoryTests
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

    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    [Fact]
    public async Task SerializeToBytesAsync_ForAFixedWeapon_ProducesThePinnedGoldenBytes()
    {
        var actual = await Codec().SerializeToBytesAsync(MakeWeapon(), GameRelease.Fallout4);

        var golden = await File.ReadAllBytesAsync(
            Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));
        Assert.Equal(golden, actual);
    }

    /// <summary>
    /// A dense real record, against the file path rather than the golden: the golden is a small
    /// synthetic weapon, and the file path threads a real directory into the serializer's
    /// StreamPackage where the in-memory path has none. If that directory ever influenced the
    /// bytes, the two would diverge here and nowhere else.
    /// </summary>
    [Fact]
    public async Task SerializeToBytesAsync_ForARealRecord_MatchesWhatSerializeAsyncWrites()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var codec = Codec();
        var dir = Directory.CreateTempSubdirectory("medit-codec-inmemory-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "record.json");
            await codec.SerializeAsync(record, filePath, GameRelease.Fallout4);

            var fromFile = await File.ReadAllBytesAsync(filePath);
            var fromMemory = await codec.SerializeToBytesAsync(record, GameRelease.Fallout4);

            Assert.NotEmpty(fromFile);
            Assert.Equal(fromFile, fromMemory);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // The leaf-count guard is load-bearing for the same reason it is in RecordTextCodecTests:
    // Assert.Empty(divergent) alone passes just as happily when the walker visits nothing.
    [Fact]
    public async Task DeserializeFromBytesAsync_RoundTripsFieldFaithfully()
    {
        var codec = Codec();
        var original = MakeWeapon();

        var bytes = await codec.SerializeToBytesAsync(original, GameRelease.Fallout4);
        var roundTripped = (Weapon)await codec.DeserializeFromBytesAsync(bytes, typeof(Weapon), GameRelease.Fallout4);

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.NotEmpty(leaves);
        Assert.Empty(divergent);
    }

    /// <summary>
    /// A container record's children are written to their own files under <c>.FilePerRecord()</c>,
    /// and their folders are created straight through the serializer's <c>IFileSystem</c>. Indexing
    /// reads containers by the tens of thousands, so "serialize this record" must not touch the
    /// disk at all — measured before this was suppressed: one real Quest created 1,057 directories,
    /// one per dialogue topic, in the process's working directory.
    ///
    /// Asserted over a real, densely-populated container rather than a synthetic one: the folder
    /// creation happens per child-bearing collection, so a container with empty collections proves
    /// nothing (the serializer returns early on an empty list).
    /// </summary>
    [Fact]
    public async Task SerializeToBytesAsync_ForAPopulatedContainer_TouchesNoFilesystem()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.First(q => q.DialogTopics.Count > 0);

        // The serializer builds child paths relative to the StreamPackage's folder, which the
        // in-memory path leaves empty — so anything it creates lands in the process's working
        // directory. Snapshotting that directory is enough to see it, and unlike setting the
        // working directory it mutates no state other tests share.
        var workingDirectory = Directory.GetCurrentDirectory();
        var before = Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal);

        var bytes = await Codec().SerializeToBytesAsync(quest, GameRelease.Fallout4);

        Assert.NotEmpty(bytes);
        Assert.Equal(before, Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal));
    }
}
