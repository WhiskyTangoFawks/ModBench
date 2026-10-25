using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed partial class EmbeddedChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private TestEditor EditService() => _fixture.EditHandler;

    private string ChildBody() => _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body;

    private string WorkingTreeCell() => _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body;

    public static TheoryData<string, Func<ContainerModFixture, FormKey>, string, string, string?, RecordEditRefusal, string> SlotsThatAreStructural => new()
    {
        { "a cell's navigation meshes set", f => f.EmbedCell, RecordEditEnvelope.Set, "NavigationMeshes", "[]", RecordEditRefusal.FieldNotFound, "has no field" },
        { "a cell's landscape cleared", f => f.EmbedCell, RecordEditEnvelope.Set, "Landscape", "null", RecordEditRefusal.FieldNotFound, "has no field" },
        { "a worldspace's top cell cleared", f => f.Worldspace, RecordEditEnvelope.Set, "TopCell", "null", RecordEditRefusal.FieldNotFound, "has no field" },
        { "a worldspace's sub-cells set", f => f.Worldspace, RecordEditEnvelope.Set, "SubCells", "[]", RecordEditRefusal.FieldNotFound, "has no field" },
        { "a cell's navigation mesh moved", f => f.EmbedCell, RecordEditEnvelope.Move, "NavigationMeshes[0]", "1", RecordEditRefusal.FieldNotFound, "has no field" },
        { "a cell's grid set", f => f.EmbedCell, RecordEditEnvelope.Set, "Grid", """{"Point": {"X": 9, "Y": 9}}""", RecordEditRefusal.FieldReadOnly, "structural gesture" },
        { "a cell's grid point set", f => f.EmbedCell, RecordEditEnvelope.Set, "Grid.Point", "\"9, 9\"", RecordEditRefusal.FieldReadOnly, "structural gesture" },
    };

    [Fact]
    public void EditingAnEmbeddedChild_RewritesItsOwnersDocument_ThatDivergesFromHead_AndTheChildReadsItBack()
    {
        Assert.Empty(_fixture.ChangedFormKeys());
        var (cellBefore, childBefore) = (WorkingTreeCell(), ChildBody());

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains(_fixture.EmbedCell.ToString(), _fixture.ChangedFormKeys());
        Assert.Equal(["Temporary[0].Scale: 1.0 -> 2.5"], DocumentDiffs.Of(cellBefore, WorkingTreeCell()));
        Assert.Equal(["Scale: 1.0 -> 2.5"], DocumentDiffs.Of(childBefore, ChildBody()));
    }

    [Theory]
    [MemberData(nameof(SlotsThatAreStructural))]
    public void AStructuralSlot_IsRefused_SoContainerChildAndCellLocationCannotGoStale(
        string _, Func<ContainerModFixture, FormKey> record, string op, string path, string? value, RecordEditRefusal refusal, string reason)
    {
        var result = EditService().Edit(_fixture.Plugin, record(_fixture).ToString(), Spelled(op, path, value));

        Assert.False(result.Applied);
        Assert.Equal(refusal, result.Refusal);
        Assert.Contains(reason, result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.ChangedFormKeys());
    }

    [Fact]
    public void AnExteriorTemporaryRefMovedOutsideItsCellsGrid_StaysInItsOwnCellsDocument()
    {
        var outsideGrid = "\"90000, -90000, 0\"";
        var before = _fixture.DocumentCarrying("ExteriorCell").Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.ExteriorRef.ToString(), "Position", Json(outsideGrid));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["""Temporary[0].Position: "100, 100, 0" -> "90000, -90000, 0" """.TrimEnd()], DocumentDiffs.Of(before, _fixture.DocumentCarrying("ExteriorCell").Body));
        Assert.Contains(_fixture.ExteriorCell.ToString(), _fixture.ChangedFormKeys());
    }

    [Fact]
    public void EveryEmbeddedSlot_ResolvesToItsOwningContainersDocument()
    {
        var service = EditService();
        var (cellBefore, worldBefore) = (EmbedCellDocument().Body, _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId).Body);

        Assert.True(service.Set(_fixture.Plugin, _fixture.PersistentRef.ToString(), "Scale", Json("2.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("3.0")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.Landscape.ToString(), "EditorID", Json("\"EditedLandscape\"")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.Navmesh.ToString(), "EditorID", Json("\"EditedNavmesh\"")).Applied);
        Assert.True(service.Set(_fixture.Plugin, _fixture.TopCell.ToString(), "WaterHeight", Json("42.0")).Applied);

        Assert.Equal(["""Landscape.EditorID: "EmbedLandscape" -> "EditedLandscape" """.TrimEnd(), """NavigationMeshes[0].EditorID: "EmbedNavmesh" -> "EditedNavmesh" """.TrimEnd(), "Persistent[0].Scale: 4.0 -> 2.0", "Temporary[0].Scale: 1.0 -> 3.0"], DocumentDiffs.Of(cellBefore, EmbedCellDocument().Body));

        var worldspace = _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId);
        Assert.Equal(["TopCell.WaterHeight: 5.0 -> 42.0"], DocumentDiffs.Of(worldBefore, worldspace.Body));
        Assert.Equal(worldspace.FormKey, _fixture.DocumentCarrying(ContainerModPlugin.TopCellEditorId).FormKey);
    }

    [Fact]
    public void APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneDocument()
    {
        var (before, childBefore) = (_fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId).Body, _fixture.Document(_fixture.TopCellRef.ToString()).Require().Body);

        var result = EditService().Set(_fixture.Plugin, _fixture.TopCellRef.ToString(), "Scale", Json("9.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["TopCell.Temporary[0].Scale: 6.0 -> 9.5"], DocumentDiffs.Of(before, _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId).Body));
        Assert.Equal(["Scale: 6.0 -> 9.5"], DocumentDiffs.Of(childBefore, _fixture.Document(_fixture.TopCellRef.ToString()).Require().Body));
    }

    [Fact]
    public void DeletingAKeyTheOwningDocumentOnlyReferences_RefusesRatherThanReportingASuccess()
    {
        var cell = EmbedCellDocument();
        _fixture.Overwrite(cell with
        {
            Body = WithoutTheTemporaryRef(cell.Body).TrimEnd().TrimEnd('}')
                   + $",\n  \"NotAChild\": {{ \"FormKey\": \"{_fixture.TemporaryRef}\" }}\n}}",
        });

        var result = _fixture.DeleteHandler.DeleteRecordsSync([new RecordAt(_fixture.Plugin, _fixture.TemporaryRef.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
        Assert.Contains("no record's document carries it", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAWorldspacesEditorId_LandsTheNewNameOnItsDocument()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Worldspace.ToString(), "EditorID", Json("\"RenamedWorld\"")).Applied);

        var renamed = _fixture.DocumentCarrying("RenamedWorld");
        Assert.Equal(_fixture.Worldspace.ToString(), renamed.FormKey);
        Assert.Equal("RenamedWorld", JsonDocument.Parse(renamed.Body).RootElement.GetProperty("EditorID").GetString());
        Assert.Equal(renamed.FormKey, _fixture.DocumentCarrying(ContainerModPlugin.TopCellEditorId).FormKey);
    }

    [Fact]
    public void EditingAQuestsEditorId_RenamesItsDocument_AndItsChildrenStayInsideIt()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Quest.ToString(), "EditorID", Json("\"RenamedQuest\"")).Applied);

        var renamed = _fixture.DocumentCarrying("RenamedQuest");
        Assert.Equal(_fixture.Quest.ToString(), renamed.FormKey);
        Assert.Equal(
            [renamed.FormKey, renamed.FormKey, renamed.FormKey, renamed.FormKey],
            new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId }
                .Select(child => _fixture.DocumentCarrying(child).FormKey));
    }

    [Fact]
    public void EditingAnEmbeddedChild_WhoseOwnerDocumentNamesNoRecord_RefusesAsUnreadableNamingTheDocument()
    {
        var cell = EmbedCellDocument();
        var file = TreeTampering.FileOf(
            _fixture.ModFolder, _fixture.Plugin, new RecordIdentity(cell.FormKey, cell.RecordType, cell.EditorId));
        var declared = $"\"FormKey\": \"{_fixture.EmbedCell}\"";
        Assert.Contains(declared, cell.Body, StringComparison.Ordinal);
        _fixture.Overwrite(cell with { Body = ReplaceFirst(cell.Body, declared, "\"FormKey\": \"NotAFormKey\"") });

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(
            Path.GetRelativePath(_fixture.ModFolder, file), result.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("moved or removed", result.Message, StringComparison.Ordinal);
    }

    private SourceDocument EmbedCellDocument() => _fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId);

    private static string WithoutTheTemporaryRef(string cellBody) =>
        TemporaryRefElement().Replace(cellBody, "");

    private static string ReplaceFirst(string text, string what, string with)
    {
        var at = text.IndexOf(what, StringComparison.Ordinal);
        return text[..at] + with + text[(at + what.Length)..];
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\s*\{[^{}]*""TempRef""[^{}]*\},?", System.Text.RegularExpressions.RegexOptions.Singleline)]
    private static partial System.Text.RegularExpressions.Regex TemporaryRefElement();
}
