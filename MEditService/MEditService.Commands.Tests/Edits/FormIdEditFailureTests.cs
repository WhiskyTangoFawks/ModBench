using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class FormIdEditFailureTests
{
    private const string NewWorldspaceFormKey = "000F00:ContainerFixture.esp";

    [Fact]
    public void AContainersFormIdEditOntoAnOccupiedPath_RefusesAsSourceAccessFailed_NamingThatThereIsNowhereToMoveTo()
    {
        using var fixture = new ContainerModFixture();
        Occupy(RelocatedWorldspaceDirectory(fixture, NewWorldspaceFormKey));

        var result = fixture.EditHandler.SetFormId(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey);

        Assert.Equal(RecordEditRefusal.SourceAccessFailed, result.Refusal);
        Assert.Contains("nowhere to move to", result.Message, StringComparison.Ordinal);
    }

    private static void Occupy(string directory)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "occupied.txt"), "something else is here");
    }

    private static string RelocatedWorldspaceDirectory(ContainerModFixture fixture, string newFormKey)
    {
        ISourceRepository Repository() => TestAdapters.Source().OverFolder(TestMod.Of(fixture.Plugin, fixture.ModFolder), GameRelease.Fallout4);
        var identity = new RecordIdentity(newFormKey, "wrld", ContainerModPlugin.WorldspaceEditorId);
        Repository().Put(fixture.Plugin, new SourceDocument(newFormKey, "wrld", ContainerModPlugin.WorldspaceEditorId, "{}")).Wrote();
        var directory = TreeTampering.DirectoryOf(fixture.ModFolder, fixture.Plugin, identity);
        Repository().Remove(fixture.Plugin, identity).Wrote();
        return directory;
    }
}
