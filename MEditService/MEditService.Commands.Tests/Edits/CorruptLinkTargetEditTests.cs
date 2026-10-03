using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CorruptLinkTargetEditTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithTrackedSource();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void PointingAFormLinkAtARecordWhoseContainerDocumentIsCorrupt_Lands()
    {
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
