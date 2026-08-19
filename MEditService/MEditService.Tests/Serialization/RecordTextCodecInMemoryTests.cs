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
}
