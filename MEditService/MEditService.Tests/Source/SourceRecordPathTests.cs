using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// #451 slice E: <see cref="SourceRecordPath"/> speaks the Spriggit flat layout —
/// <c>&lt;plugin&gt;.source/&lt;GroupFolder&gt;/[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;.json</c>,
/// group-folder names resolved via <see cref="RecordTypeDispatch"/> rather than hardcoded here, so
/// these tests do not silently drift from whatever the reflection walk actually decides. Rewritten
/// from the pre-#451 flat <c>&lt;recordType&gt;/&lt;originModKey&gt;/&lt;hex6&gt;.json</c> version —
/// <see cref="SourceRecordIdentity"/> no longer carries a FormKey (see its own doc comment for why).
/// </summary>
public sealed class SourceRecordPathTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    [Theory]
    // The routine case.
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", "SomeNpc")]
    // No EditorID — the bare filesafe FormKey, no leading "&lt;EditorID&gt; - ".
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", null)]
    // A plugin name with its own internal dot must not confuse suffix-stripping (SourceRecordPath
    // strips a trailing ".source", never splits on the first dot) — a patch-plugin-shaped filename
    // proves this for real rather than by argument.
    [InlineData("Vendor.patch.esp", "keyword", "0012AB:Vendor.patch.esp", "SomeKeyword")]
    // The record's origin ModKey legitimately differs from the plugin holding it (an override edited
    // through a patch plugin) — the two segments must recombine into the *origin's* FormKey, not the
    // target plugin's.
    [InlineData("Vendor.esp", "npc_", "000800:Master1.esm", "AnOverride")]
    // Non-ASCII plugin names and EditorIDs are ordinary in this modding scene (review finding 1, #368)
    // — the identity recovered from the path must carry the same plugin-name bytes For() started from.
    [InlineData("Café.esp", "npc_", "000800:Café.esp", "Né")]
    [InlineData("Плагин.esp", "npc_", "0012AB:Плагин.esp", "Имя")]
    public void For_ThenTryParse_RoundTripsPluginAndRecordType(
        string pluginFileName, string recordType, string formKeyString, string? editorId)
    {
        var path = SourceRecordPath.For(pluginFileName, recordType, formKeyString, editorId, Release);

        var ok = SourceRecordPath.TryParse(path, Release, out var identity);

        Assert.True(ok, $"expected TryParse to succeed for a path For() itself produced: '{path}'");
        Assert.Equal(pluginFileName, identity.PluginFileName);
        // TryParse answers RecordTypeDispatch's own schema-table-name spelling (DuckDbRecordIndex's
        // own dictionary is keyed by that spelling only — #451 review); For() accepts either spelling
        // (RecordTypeDispatch.ConcreteFor's dual keying). The two need not match textually, only
        // resolve to the same concrete type, which this equality (via the same lookup) checks for real
        // rather than assuming a spelling.
        var expectedConcrete = RecordTypeDispatch.For(Release).ConcreteFor(recordType);
        Assert.NotNull(expectedConcrete);
        Assert.Equal(expectedConcrete, RecordTypeDispatch.For(Release).ConcreteFor(identity.RecordType));
    }

    [Theory]
    [InlineData("Cell")]
    [InlineData("Worldspace")]
    [InlineData("Quest")]
    public void For_ForADirectoryPerRecordType_ThrowsNamedException(string recordType)
    {
        var ex = Assert.Throws<NotSupportedException>(
            () => SourceRecordPath.For("Vendor.esp", recordType, "000800:Vendor.esp", "SomeName", Release));

        Assert.Contains(recordType, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void For_ForATypeWithNoTopLevelGroup_ThrowsNamedException()
    {
        // A placed reference lives inside a cell's own document, never under a top-level group of its
        // own (RecordTypeDispatch.FolderNameFor's own doc comment) — the same "ask SourceUnitResolver"
        // refusal as a directory-per-record type, for a structurally different reason.
        Assert.Throws<NotSupportedException>(
            () => SourceRecordPath.For("Vendor.esp", "placedobject", "000800:Vendor.esp", "SomeRef", Release));
    }

    [Theory]
    // Too few / too many path segments — the flat shape is exactly three: <plugin>.source/<folder>/<file>.json.
    [InlineData("Vendor.esp.source/000800.json")]
    [InlineData("Vendor.esp.source/Npcs/Vendor.esp/000800.json")]
    // First segment missing the load-bearing ".source" suffix.
    [InlineData("Vendor.esp/Npcs/000800.json")]
    // Last segment missing the load-bearing ".json" suffix.
    [InlineData("Vendor.esp.source/Npcs/000800.txt")]
    [InlineData("Vendor.esp.source/Npcs/000800")]
    // A bare ".source" — the suffix matches but strips to an empty plugin name, never a real identity.
    [InlineData(".source/Npcs/000800.json")]
    // The whole-mod door's own header/group files — never a flat record's own file.
    [InlineData("Vendor.esp.source/Npcs/RecordData.json")]
    [InlineData("Vendor.esp.source/Cells/GroupRecordData.json")]
    // A folder this game's schema has no group for at all.
    [InlineData("Vendor.esp.source/NotARealFolder/000800.json")]
    public void TryParse_MalformedOrUnmappedPaths_FailsCleanly(string relativePath)
    {
        // Malformed input must fail outright, not return a *wrong* parse (review finding 2, #368) — a
        // silent mis-parse would mislabel a user's change, which is worse than dropping it. Every OS
        // uses '/' as its own DirectorySeparatorChar equally happily as a path separator here
        // (Path.Combine on Windows would have written '\\', but these theories construct the string
        // directly rather than through For(), so '/' is deliberate and portable).
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);

        var ok = SourceRecordPath.TryParse(normalized, Release, out var identity);

        Assert.False(ok, $"expected TryParse to fail for a malformed or unmapped path: '{relativePath}'");
        Assert.Null(identity);
    }

    // A folder whose group element is abstract (several concrete types share it — e.g. Globals holds
    // GlobalFloat/GlobalBool/GlobalInt/GlobalShort) reads as ambiguous, same as the whole-mod door's
    // own discriminator policy: the document is asked to self-describe rather than TryParse guessing
    // one of several concrete types from the folder name alone.
    [Fact]
    public void TryParse_ForAnAmbiguousGroupsFolder_FailsCleanly()
    {
        var ambiguousFolder = RecordTypeDispatch.For(Release).FolderNameFor("globalfloat");
        Assert.NotNull(ambiguousFolder); // sanity: GlobalFloat is a flat type with a real folder...
        var path = Path.Combine("Vendor.esp.source", ambiguousFolder!, "SomeGlobal - 000800_Vendor.esp.json");

        var ok = SourceRecordPath.TryParse(path, Release, out var identity);

        Assert.False(ok, "...but that folder is shared with GlobalBool/GlobalInt/GlobalShort, so it must not resolve.");
        Assert.Null(identity);
    }
}
