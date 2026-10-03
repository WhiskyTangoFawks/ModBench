using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

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
    public void SerializeToBytes_WithACancelledToken_Throws()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        Assert.ThrowsAny<OperationCanceledException>(
            () => Codec().SerializeToBytes(MakeWeapon(), GameRelease.Fallout4, cancelled.Token));
    }

    [Fact]
    public async Task SerializeToBytes_ForAFixedWeapon_ProducesThePinnedGoldenBytes()
    {
        var actual = Codec().SerializeToBytes(MakeWeapon(), GameRelease.Fallout4);

        var golden = await File.ReadAllBytesAsync(
            Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));
        Assert.Equal(golden, actual);
    }

    [Fact]
    public async Task SerializeToBytes_ForARealRecord_MatchesWhatSerializeAsyncWrites_ForADenseRecordNeverComparedAgainstItselfBecauseTheInMemoryBytesMustBeTheSourceFilesBytes()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var codec = Codec();
        using var dir = new ScratchDirectory("medit-codec-inmemory-");
        var filePath = Path.Combine(dir.Path, "record.json");
        await codec.SerializeAsync(record, filePath, GameRelease.Fallout4);

        var fromFile = await File.ReadAllBytesAsync(filePath);
        var fromMemory = codec.SerializeToBytes(record, GameRelease.Fallout4);

        Assert.NotEmpty(fromFile);
        Assert.Equal(fromFile, fromMemory);
    }

    [Fact]
    public void DeserializeFromBytes_RoundTripsFieldFaithfully()
    {
        var codec = Codec();
        var original = MakeWeapon();

        var bytes = codec.SerializeToBytes(original, GameRelease.Fallout4);
        var roundTripped = (Weapon)codec.DeserializeFromBytes(bytes, GameRelease.Fallout4, "weap");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.True(leaves.Count > 0, "Expected the walker to visit leaves; Assert.Empty(divergent) alone passes just as happily when it visits nothing.");
        Assert.Empty(divergent);
    }

    [Fact]
    public void SerializeToBytes_ForAPopulatedContainer_TouchesNoFilesystem()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.First(q => q.DialogTopics.Count > 0);

        var workingDirectoryWhereAnythingTheSerializerCreatesLandsBecauseChildPathsAreRelativeToAnEmptyStreamPackageFolder = Directory.GetCurrentDirectory();
        var workingDirectory = workingDirectoryWhereAnythingTheSerializerCreatesLandsBecauseChildPathsAreRelativeToAnEmptyStreamPackageFolder;
        var before = Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal);

        var bytes = Codec().SerializeToBytes(quest, GameRelease.Fallout4);

        Assert.NotEmpty(bytes);
        Assert.Equal(before, Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal));
    }
}
