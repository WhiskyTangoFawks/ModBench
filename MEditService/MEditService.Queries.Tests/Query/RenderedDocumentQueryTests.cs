using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public sealed class RenderedDocumentQueryTests
{
    private const string Npc = "000800:Shared.esp";
    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");

    private static RecordQueryService Service(params RecordDocument[] copies) =>
        new(
            new FakeIndex(new FakeReads(
                new Dictionary<PluginAddress, PluginContent>(),
                [.. copies.Select(c => new FakeRow(c.Plugin, 0, IsWinner: false, c))])),
            FakeLoadOrder.Of(GameRelease.Fallout4),
            SharedSchemaReflector.Instance);

    private static RecordDocument Copy(PluginAddress plugin, string body, string? parseDiagnosis = null) =>
        new(Npc, plugin, 0, IsWinner: false, "SharedNpc", "npc_", body, [], ParseDiagnosis: parseDiagnosis);

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
