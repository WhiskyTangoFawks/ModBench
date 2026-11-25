using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewTests
{
    [Fact]
    public void CopyRecordAsNewRecord_AllocatesAFreeFormKey_AndLandsAsAWorkingTreeRecordInTheDestination()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.NotEqual(mod.SourceNpc.ToString(), newFormKey);
        Assert.EndsWith(":" + CopyFixture.DestinationPluginName, newFormKey, StringComparison.Ordinal);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", document.EditorId);

        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    public static TheoryData<string, Func<CopyFixture, FormKey>, string?> EditorIdsDerived => new()
    {
        { "a source named", mod => mod.SourceNpc, CopyFixture.SourceNpcEditorId + "DUPLICATE002" },
        { "a source with no EditorID", mod => mod.SourceNpcWithNoEditorId, null },
    };

    [Theory]
    [MemberData(nameof(EditorIdsDerived))]
    public void CopyRecordAsNewRecord_NamesTheCopyAfterItsSource_PastANameTheDestinationHoldsInAnyCase(
        string _, Func<CopyFixture, FormKey> source, string? expected)
    {
        using var mod = CopyFixture.Create();
        Assert.True(mod.EditHandler.Set(
            mod.DestinationPlugin, mod.DestinationNpc.ToString(), "EditorID",
            JsonDocument.Parse("\"SOURCENPCDUPLICATE001\"").RootElement).Applied);

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, source(mod).ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var document = mod.Document(mod.DestinationPlugin, result.OnlyLanded().Require());
        Assert.NotNull(document);
        Assert.Equal(expected, document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_RemapsASelfReference_OntoTheNewFormKey_NotTheOriginal()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SelfLinkingFaction.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Contains(newFormKey, document.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(mod.SelfLinkingFaction.ToString(), document.Body, StringComparison.Ordinal);
    }

    public static TheoryData<string, Func<ContainerCopyFixture, FormKey>> CellsAndWorldspaces => new()
    {
        { "a cell", fixture => fixture.InteriorCell },
        { "a worldspace", fixture => fixture.Worldspace },
    };

    [Theory]
    [MemberData(nameof(CellsAndWorldspaces))]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsACellOrAWorldspace_PermanentlyDisallowed(string _, Func<ContainerCopyFixture, FormKey> source)
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, source(fixture).ToString())], CopyMode.New, [fixture.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, refused.Refusal);
    }
}
