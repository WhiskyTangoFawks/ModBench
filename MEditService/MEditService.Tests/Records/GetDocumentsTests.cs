using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

// #547: CollectDiagnostics used to point-read one document per record (two DuckDB round trips
// each — ~7,880 queries and ~40s of a 41s Compile on the real 3,940-record fixture), so the seam
// grew a bulk read: every document one plugin's copy holds, in one query. These tests pin the bulk
// read against the point read it replaces — the two run independent SQL, so agreement is evidence,
// not tautology.
public class GetDocumentsTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    // One resolvable FormLink (Npc.Race → a Race this same mod carries) and one dangling one
    // (a FormKey naming a plugin nothing indexed), so the parity check below covers CheckError
    // both ways — null and populated — through the same shared-resolution path the bulk read uses.
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
        repo.Index(mod, Registration.Participating(0), key);
        // Resolution answers from form_lookup's winning rows, so without the winner sweep every
        // FormLink in the fixture reads as dangling — the sweep is part of the real load pipeline.
        repo.UpdateWinners();

        var documents = repo.GetDocuments(key);

        Assert.Equal(mod.EnumerateMajorRecords().Count(), documents.Count);
        Assert.All(documents, doc =>
        {
            var pointRead = repo.GetDocument(doc.FormKey, key);
            Assert.NotNull(pointRead);
            Assert.Equal(pointRead.EditorId, doc.EditorId);
            Assert.Equal(pointRead.RecordType, doc.RecordType);
            Assert.Equal(pointRead.Body, doc.Body);
            Assert.Equal(
                pointRead.Fields.Select(f => (f.Metadata.Name, f.CheckError)),
                doc.Fields.Select(f => (f.Metadata.Name, f.CheckError)));
        });
        // The fixture's premise, asserted so a fixture edit can't quietly hollow out the CheckError
        // half of the parity above: the dangling race flags, the resolvable one doesn't. Scoped to
        // the race field — a bare AddNew NPC carries other required-but-unset links that flag too.
        string? RaceError(string editorId) => documents
            .Single(d => d.EditorId == editorId).Fields
            .Single(f => f.Metadata.Name.Equals("race", StringComparison.OrdinalIgnoreCase))
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
        repo.Index(modA, Registration.Participating(0), new PluginKey("Shared.esp", "ModA"));
        repo.Index(modB, Registration.Participating(1), new PluginKey("Shared.esp", "ModB"));

        var fromA = repo.GetDocuments(new PluginKey("Shared.esp", "ModA"));
        var fromB = repo.GetDocuments(new PluginKey("Shared.esp", "ModB"));

        var single = Assert.Single(fromA);
        Assert.Equal("FromModA", single.EditorId);
        Assert.Equal("ModA", single.Plugin.Origin);
        Assert.Equal(2, fromB.Count);
        Assert.All(fromB, d => Assert.Equal("ModB", d.Plugin.Origin));
    }
}
