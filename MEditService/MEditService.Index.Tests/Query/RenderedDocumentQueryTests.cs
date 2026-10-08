using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Index.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

public sealed class RenderedDocumentQueryTests
{
    private const string Npc = "000800:Shared.esp";
    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");

    private static IRecordQueryService Service(params RecordDocument[] copies) =>
        QueryHost.Records(
            new FakeIndex(new FakeReads(
                new Dictionary<PluginAddress, PluginContent>(),
                [.. copies.Select(c => new FakeRow(c))])),
            FakeLoadOrder.Of(GameRelease.Fallout4));

    private static RecordDocument Copy(PluginAddress plugin, string body, string? parseDiagnosis = null) =>
        new(Npc, plugin, 0, IsWinner: false, "SharedNpc", "npc_", body, [], ParseDiagnosis: parseDiagnosis);

    [Fact]
    public void APlacedReference_IsNamedByItsOwnEditorId()
    {
        const string placed = "000801:Shared.esp";
        var svc = Service(new RecordDocument(placed, ModA, 0, IsWinner: false, "SharedRef", "refr", "{}", []));

        Assert.Equal("SharedRef - 000801_Shared.esp.json", svc.GetRenderedDocument(ModA, placed)?.FileName);
    }

    [Fact]
    public void ACopy_RendersAsTheDocumentItsPluginHolds_NotAnotherOfTheSameName()
    {
        var svc = Service(Copy(ModA, """{ "held": "by ModA" }"""), Copy(ModB, """{ "held": "by ModB" }"""));

        Assert.Equal("""{ "held": "by ModB" }""", svc.GetRenderedDocument(ModB, Npc)?.Text);
    }

    [Fact]
    public void ACopyMEditCouldNotParse_RendersWhatCouldBeStored()
    {
        var svc = Service(Copy(ModA, """{ "stub": true }""", parseDiagnosis: "Mutagen could not read it."));

        Assert.Equal("""{ "stub": true }""", svc.GetRenderedDocument(ModA, Npc)?.Text);
    }

    [Fact]
    public void ACopyThePluginDoesNotHold_HasNoRendering()
    {
        Assert.Null(Service(Copy(ModA, "{}")).GetRenderedDocument(ModB, Npc));
    }
}
