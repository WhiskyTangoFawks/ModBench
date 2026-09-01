using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

// The production wiring end to end — DuckDbRecordIndex.Initialize's GameRelease has to
// actually reach FormKeyResolution.From through BuildFields and
// CheckErrorBuilder.Build for the exemption to take effect on a real read, not just at the unit-level
// seams (FormKeyResolutionTests, CheckErrorBuilderTests) that construct their own GameRelease by
// hand. Mirrors GetDocumentsTests' BuildMod/OpenRepo shape.
public class HardcodedFormKeyResolutionTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    [Fact]
    public void GetDocument_FieldReferencesEngineHardcodedPlayerFormKey_NoCheckError()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Hardcoded.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("PlayerReferencer");
        // 00000007:Fallout4.esm — the Player, engine-hardcoded, never present in form_lookup.
        npc.Race.SetTo(new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x000007));

        using var repo = OpenRepo();
        var key = new PluginKey("Hardcoded.esp", "ModA");
        repo.Index(mod, Registration.Participating(0), key);
        repo.UpdateWinners();

        var doc = repo.At(RecordRef.Effective).GetDocument(npc.FormKey.ToString(), key);

        Assert.NotNull(doc);
        var raceField = doc!.Fields.Single(f => f.Metadata.Name.Equals("race", StringComparison.OrdinalIgnoreCase));
        Assert.Null(raceField.CheckError);
    }
}
