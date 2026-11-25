using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Tests.RealData;

[Kind(Kinds.Tool)]
public sealed class VanillaMasterFormatTests
{
    public static TheoryData<GameRelease, string> InstalledVanillaMasters()
    {
        var rows = new TheoryData<GameRelease, string>();
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.SkyrimSE, GameRelease.Starfield })
        {
            if (!new GameLocator().TryGetDataDirectory(release, out var dataDir)) continue;
            foreach (var path in Directory.EnumerateFiles(dataDir.Path, "*.esm")) rows.Add(release, Path.GetFileName(path));
        }
        return rows;
    }

    private static IModDisposeGetter OpenedWithItsMastersStyles(GameRelease release, string fileName)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var dataDir));
        var styles = new Cache<IModMasterStyledGetter, ModKey>(style => style.ModKey);
        foreach (var master in Directory.EnumerateFiles(dataDir.Path, "*.esm")) styles.Add(KeyedMasterStyle.FromPath(master, release));
        return ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(fileName), Path.Combine(dataDir.Path, fileName)), release, new BinaryReadParameters { MasterFlagsLookup = styles });
    }

    [Theory]
    [MemberData(nameof(InstalledVanillaMasters))]
    public void EveryRecordOfAVanillaMaster_ReadsBackFromTheFormatsText_AndTheRecompilesNormalizationLeavesThatTextAsItIs(
        GameRelease release, string fileName)
    {
        using var master = OpenedWithItsMastersStyles(release, fileName);
        var game = GameCodecs.For(release);
        var types = RecordTypes.For(release);

        var differing = master.EnumerateMajorRecords()
            .Select(record => record.DeepCopy())
            .Select(copy => (Record: copy, Text: RecordTextCodec.SerializeToText(copy, release)))
            .Where(written => RecordTextCodec.RoundTrip(written.Text, release, types.RecordTypeOf(written.Record)) != written.Text
                || RecordTextCodec.SerializeToText(game.NormalizeFormat(written.Record), release) != written.Text)
            .Select(written => written.Record.FormKey.ToString())
            .Take(20)
            .ToList();

        Assert.Empty(differing);
    }
}
