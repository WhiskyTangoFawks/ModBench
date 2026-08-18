using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #368 review finding 2: <see cref="LedgerRecordPath.TryParse"/> — the reverse of
/// <see cref="LedgerRecordPath.For"/> that <see cref="MEditService.Core.Ledger.LedgerStatusQuery"/>
/// leans on to name every changed record without a YAML read — had no direct coverage of its own
/// before this; every existing exercise of it went through ASCII-only paths inside the API host, so
/// a genuine parse defect (the non-ASCII quoting regression, finding 1) reached production without
/// a single test failing here. Real git and the API host are the wrong seam for this: it's a pure
/// string transform, so plain xUnit theories are enough.
/// </summary>
public sealed class LedgerRecordPathTests
{
    [Theory]
    // The routine case.
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp")]
    // A plugin name with its own internal dot must not confuse suffix-stripping (LedgerRecordPath
    // strips a trailing ".ledger", never splits on the first dot) — a patch-plugin-shaped filename
    // proves this for real rather than by argument.
    [InlineData("Vendor.patch.esp", "cell", "0012AB:Vendor.patch.esp")]
    // The record's origin ModKey legitimately differs from the plugin it's staged onto (an
    // override edited through a patch plugin, RecordQueryService.GetRecordForPlugin's own reason
    // for existing) — the two segments must recombine into the *origin's* FormKey, not the target
    // plugin's.
    [InlineData("Vendor.esp", "npc_", "000800:Master1.esm")]
    // Non-ASCII plugin names are ordinary in this modding scene (review finding 1) — the identity
    // recovered from the path must carry the same bytes For() started from, unescaped.
    [InlineData("Café.esp", "npc_", "000800:Café.esp")]
    [InlineData("Плагин.esp", "npc_", "0012AB:Плагин.esp")]
    public void For_ThenTryParse_RoundTripsExactIdentity(string pluginFileName, string recordType, string formKeyString)
    {
        var path = LedgerRecordPath.For(pluginFileName, recordType, formKeyString);

        var ok = LedgerRecordPath.TryParse(path, out var identity);

        Assert.True(ok, $"expected TryParse to succeed for a path For() itself produced: '{path}'");
        Assert.Equal(pluginFileName, identity.PluginFileName);
        Assert.Equal(recordType, identity.RecordType);
        Assert.Equal(formKeyString, identity.FormKey);
    }

    [Theory]
    // Too few / too many path segments.
    [InlineData("Vendor.esp.ledger/npc_/000800.yaml")]
    [InlineData("Vendor.esp.ledger/npc_/Vendor.esp/extra/000800.yaml")]
    // First segment missing the load-bearing ".ledger" suffix.
    [InlineData("Vendor.esp/npc_/Vendor.esp/000800.yaml")]
    // Last segment missing the load-bearing ".yaml" suffix.
    [InlineData("Vendor.esp.ledger/npc_/Vendor.esp/000800.txt")]
    [InlineData("Vendor.esp.ledger/npc_/Vendor.esp/000800")]
    // A bare ".ledger"/".yaml" — the suffix matches but strips to an empty plugin name / local id,
    // which is never a real identity (nothing For() produces can look like this).
    [InlineData(".ledger/npc_/Vendor.esp/000800.yaml")]
    [InlineData("Vendor.esp.ledger/npc_/Vendor.esp/.yaml")]
    public void TryParse_MalformedPaths_FailsCleanly(string relativePath)
    {
        // Malformed input must fail outright, not return a *wrong* parse (review finding 2) — a
        // silent mis-parse would mislabel a user's change, which is worse than dropping it. Every
        // OS uses '/' as its own DirectorySeparatorChar equally happily as a path separator here
        // (Path.Combine on Windows would have written '\\', but these theories construct the
        // string directly rather than through For(), so '/' is deliberate and portable).
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);

        var ok = LedgerRecordPath.TryParse(normalized, out var identity);

        Assert.False(ok, $"expected TryParse to fail for a malformed path: '{relativePath}'");
        Assert.Null(identity);
    }
}
