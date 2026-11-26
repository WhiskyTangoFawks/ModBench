using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public class RecordTextCodecInMemoryTests
{
    [Fact]
    public void WritingAPopulatedContainersText_TouchesNoFilesystem_ThroughTheWorkingDirectoryWhereChildPathsLandBecauseTheyAreRelativeToAnEmptyStreamPackageFolder()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("InMemory.esp"), Fallout4Release.Fallout4);
        var topic = new DialogTopic(mod) { EditorID = "Topic" };
        topic.Responses.Add(new DialogResponses(mod));
        var quest = new Quest(mod) { EditorID = "Quest", DialogTopics = [topic] };

        var workingDirectory = Directory.GetCurrentDirectory();
        var before = Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal);

        var text = RecordTextCodec.SerializeToText(quest, GameRelease.Fallout4);

        Assert.NotEmpty(text);
        Assert.Equal(before, Directory.GetDirectories(workingDirectory).ToHashSet(StringComparer.Ordinal));
    }
}
