using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Nothing on the write side opens another plugin's contents to answer an edit: a link
/// whose target document is unreadable lands like any other well-shaped value.</summary>
public sealed class CorruptLinkTargetEditTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithTrackedSource();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void PointingAFormLinkAtARecordWhoseContainerDocumentIsCorrupt_Lands()
    {
        // The reference is inlined in its cell's document, so corrupting that document is what would
        // make the target unnameable to a write side that read it.
        var cellFile = _mod.SourceFileContaining(_mod.SourcePlugin, ContainerCopyFixture.PersistentRefEditorId);
        File.WriteAllText(
            cellFile,
            File.ReadAllText(cellFile).Replace(
                $"\"EditorID\": \"{ContainerCopyFixture.PersistentRefEditorId}\"",
                $"\"MajorRecordFlagsRaw\": notanumber,\n\"EditorID\": \"{ContainerCopyFixture.PersistentRefEditorId}\"",
                StringComparison.Ordinal));

        var result = _mod.EditHandler.Set(
            _mod.SourcePlugin, _mod.FlatNpc.ToString(), "Keywords",
            JsonDocument.Parse($"[\"{_mod.PersistentRef}\"]").RootElement);

        Assert.True(result.Applied, result.Message);
    }
}
