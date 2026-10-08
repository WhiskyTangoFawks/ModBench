using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public class RecordTextCodecInMemoryTests
{

    [Fact]
    public void SerializeToText_ForAPopulatedContainer_TouchesNoFilesystem_ThroughTheWorkingDirectoryWhereChildPathsLandBecauseTheyAreRelativeToAnEmptyStreamPackageFolder()
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.First(q => q.DialogTopics.Count > 0);

        var workingDirectory = Directory.GetCurrentDirectory();
        var before = Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal);

        var text = RecordTextCodec.SerializeToText(quest, GameRelease.Fallout4);

        Assert.NotEmpty(text);
        Assert.Equal(before, Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal));
    }
}
