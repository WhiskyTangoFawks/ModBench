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
        var cell = _mod.DocumentCarrying(_mod.SourcePlugin, ContainerCopyFixture.PersistentRefEditorId);
        _mod.Overwrite(
            _mod.SourcePlugin,
            cell with { Body = cell.Body.Replace(
                $"\"EditorID\": \"{ContainerCopyFixture.PersistentRefEditorId}\"",
                $"\"MajorRecordFlagsRaw\": notanumber,\n\"EditorID\": \"{ContainerCopyFixture.PersistentRefEditorId}\"",
                StringComparison.Ordinal) });

        var result = _mod.EditHandler.Set(
            _mod.SourcePlugin, _mod.FlatNpc.ToString(), "Keywords",
            JsonDocument.Parse($"[\"{_mod.PersistentRef}\"]").RootElement);

        Assert.True(result.Applied, result.Message);
    }
}
