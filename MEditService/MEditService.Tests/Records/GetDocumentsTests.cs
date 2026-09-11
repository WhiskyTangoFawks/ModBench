using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

// Point-reading one document per record costs two DuckDB round trips each, so the seam carries a
// bulk read: every document one plugin's copy holds, in one query.
public class GetDocumentsTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    // One resolvable FormLink and one dangling one, so the parity check below covers CheckError both
    // ways through the same shared-resolution path the bulk read uses.
    private static Fallout4Mod BuildMod()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Bulk.esp"), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("BulkRace");
        var npc = mod.Npcs.AddNew("BulkNpc");
        npc.Race.SetTo(race.FormKey);
        var broken = mod.Npcs.AddNew("BrokenNpc");
        broken.Race.SetTo(new FormKey(ModKey.FromFileName("Missing.esp"), 0x000801));
        return mod;
    }

    [Fact]
    public void GetDocuments_ReturnsEveryDocumentThePluginIndexed_IdenticalToPointReads()
    {
        var mod = BuildMod();
        var key = new PluginKey("Bulk.esp", "ModA");

        using var repo = OpenRepo();
        repo.IndexMod(mod, Registration.Participating(0), key);
        // Resolution answers from form_lookup's winning rows, so without the winner sweep every
        // FormLink in the fixture reads as dangling — the sweep is part of the real load pipeline.
        repo.UpdateWinners();

        var documents = repo.At(RecordRef.Effective).GetDocuments(key);

        // Every major record, plus the plugin header's document, which EnumerateMajorRecords structurally
        // cannot count. Asserted as its own presence rather than folded into a "+1", so this still fails
        // if the extra row is something else entirely.
        Assert.Equal(mod.EnumerateMajorRecords().Count() + 1, documents.Count);
        Assert.Single(documents, d => d.RecordType == PluginHeader.RecordType);
        // ...and the point-read parity below covers the header on the same terms as every record,
        // which is the whole claim of the change: one read path, no special case.
        Assert.All(documents, doc =>
        {
            var pointRead = repo.At(RecordRef.Effective).GetDocument(doc.FormKey, key);
            Assert.NotNull(pointRead);
            Assert.Equal(pointRead.EditorId, doc.EditorId);
            Assert.Equal(pointRead.RecordType, doc.RecordType);
            Assert.Equal(pointRead.Body, doc.Body);
            Assert.Equal(
                pointRead.Fields.Select(f => (f.Metadata.Name, f.CheckError)),
                doc.Fields.Select(f => (f.Metadata.Name, f.CheckError)));
        });
        // The fixture's premise, asserted so a fixture edit cannot hollow out the CheckError half of the
        // parity above. Scoped to the race field: a bare AddNew NPC carries other unset links that flag.
        string? RaceError(string editorId) => documents
            .Single(d => d.EditorId == editorId).Fields
            .Single(f => f.Metadata.Name.Equals("Race", StringComparison.OrdinalIgnoreCase))
            .CheckError;
        Assert.Null(RaceError("BulkNpc"));
        Assert.Contains("Could not be resolved", RaceError("BrokenNpc"));
    }

    [Fact]
    public void GetDocuments_TwoOriginsSameFilename_ScopesToRequestedOrigin()
    {
        var modA = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modA.Npcs.AddNew("FromModA");
        var modB = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        modB.Npcs.AddNew("FromModB");
        modB.Npcs.AddNew("SecondFromModB");

        using var repo = OpenRepo();
        repo.IndexMod(modA, Registration.Participating(0), new PluginKey("Shared.esp", "ModA"));
        repo.IndexMod(modB, Registration.Participating(1), new PluginKey("Shared.esp", "ModB"));

        // Records only: each copy also carries its own header document, which is scoped
        // by origin exactly like the records are (asserted separately below) but says nothing about
        // the per-origin *record* scoping this test is about.
        var fromA = repo.At(RecordRef.Effective).GetDocuments(new PluginKey("Shared.esp", "ModA"));
        var fromB = repo.At(RecordRef.Effective).GetDocuments(new PluginKey("Shared.esp", "ModB"));
        var recordsFromA = fromA.Where(d => d.RecordType != PluginHeader.RecordType).ToList();
        var recordsFromB = fromB.Where(d => d.RecordType != PluginHeader.RecordType).ToList();

        var single = Assert.Single(recordsFromA);
        Assert.Equal("FromModA", single.EditorId);
        Assert.Equal("ModA", single.Plugin.Origin);
        Assert.Equal(2, recordsFromB.Count);
        Assert.All(recordsFromB, d => Assert.Equal("ModB", d.Plugin.Origin));

        // ADR-0012: the header is per-copy too — one each, each carrying its own origin, never one
        // shared row keyed on the filename the two copies have in common.
        Assert.Equal("ModA", Assert.Single(fromA, d => d.RecordType == PluginHeader.RecordType).Plugin.Origin);
        Assert.Equal("ModB", Assert.Single(fromB, d => d.RecordType == PluginHeader.RecordType).Plugin.Origin);
    }
}
