using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #371 Q1: <see cref="LedgerRecordFieldReader"/> is the scratch-index round trip that stands in
/// for a hand-written native→JSON mapper (orchestrator-directed — see the class's own remarks for
/// why). This is the fidelity coverage that decision calls for: the three field shapes a
/// hand-written mapper would most plausibly get wrong — enum, FormKey, and an array carrying
/// FormKeys — proven to come back exactly as staged, not just "some value came back".
/// </summary>
public class LedgerRecordFieldReaderTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;

    [Fact]
    public void ReadFields_EnumFormKeyAndFormKeyArrayFields_RoundTripExactly()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Scratch.esp"), Fallout4Release.Fallout4);
        var keyword1 = mod.Keywords.AddNew();
        var keyword2 = mod.Keywords.AddNew();
        var npc = mod.Npcs.AddNew("ScratchNpc");
        npc.Aggression = Npc.AggressionType.Aggressive; // enum
        npc.Keywords = [new FormLink<IKeywordGetter>(keyword1.FormKey), new FormLink<IKeywordGetter>(keyword2.FormKey)]; // array of FormKey

        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["npc_"];
        var repositoryFactory = new DuckDbRecordRepositoryFactory(Reflector, new TableDdlBuilder(Reflector));
        var reader = new LedgerRecordFieldReader(repositoryFactory);

        var fields = reader.ReadFields(npc, schema, "Scratch.esp", GameRelease.Fallout4);

        Assert.Equal("Aggressive", fields["aggression"].GetString());

        var keywordFormKeys = fields["keywords"].EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal([keyword1.FormKey.ToString(), keyword2.FormKey.ToString()], keywordFormKeys);
    }

    // The empty-array case is its own fidelity edge: a hand-written mapper distinguishing "empty
    // array" from "field absent"/"null" is exactly the kind of divergence Q1 worries about.
    [Fact]
    public void ReadFields_EmptyFormKeyArrayField_RoundTripsAsEmptyArray_NotNullOrMissing()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Scratch.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("ScratchNpc");
        npc.Keywords = []; // explicitly empty, not left unset (unset is null — a different, valid state)

        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["npc_"];
        var repositoryFactory = new DuckDbRecordRepositoryFactory(Reflector, new TableDdlBuilder(Reflector));
        var reader = new LedgerRecordFieldReader(repositoryFactory);

        var fields = reader.ReadFields(npc, schema, "Scratch.esp", GameRelease.Fallout4);

        Assert.True(fields.TryGetValue("keywords", out var keywords));
        Assert.Equal(JsonValueKind.Array, keywords.ValueKind);
        Assert.Empty(keywords.EnumerateArray());
    }
}
