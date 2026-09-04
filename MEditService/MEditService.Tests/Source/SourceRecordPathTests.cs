using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>Group-folder names come from <see cref="RecordTypeDispatch"/> rather than literals, so
/// these tests cannot drift from whatever the reflection walk decides.</summary>
public sealed class SourceRecordPathTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    [Theory]
    // The routine case.
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", "SomeNpc")]
    // No EditorID — the bare filesafe FormKey, no leading "&lt;EditorID&gt; - ".
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", null)]
    // A plugin name with its own internal dot must round-trip as one whole segment (SourceRecordPath
    // never splits a plugin name on its own dots) — a patch-plugin-shaped filename proves this for
    // real rather than by argument.
    [InlineData("Vendor.patch.esp", "keyword", "0012AB:Vendor.patch.esp", "SomeKeyword")]
    // The record's origin ModKey legitimately differs from the plugin holding it (an override edited
    // through a patch plugin) — the two segments must recombine into the *origin's* FormKey, not the
    // target plugin's.
    [InlineData("Vendor.esp", "npc_", "000800:Master1.esm", "AnOverride")]
    // Non-ASCII plugin names and EditorIDs are ordinary in this modding scene — the identity
    // recovered from the path must carry the same plugin-name bytes For() started from.
    [InlineData("Café.esp", "npc_", "000800:Café.esp", "Né")]
    [InlineData("Плагин.esp", "npc_", "0012AB:Плагин.esp", "Имя")]
    public void For_ThenTryParse_RoundTripsPluginAndRecordType(
        string pluginFileName, string recordType, string formKeyString, string? editorId)
    {
        var path = SourceRecordPath.For(pluginFileName, recordType, formKeyString, editorId, Release);

        // Everything nests under one root "source/" folder, the plugin its own child directory, not a
        // "<plugin>.source/" sibling tree. Asserted rather than implied by TryParse round-tripping: a
        // broken root four segments deep would round-trip too.
        var segments = path.Split(Path.DirectorySeparatorChar);
        Assert.Equal(SourceRecordPath.RootFolderName, segments[0]);
        Assert.Equal(pluginFileName, segments[1]);

        var ok = SourceRecordPath.TryParse(path, Release, out var identity);

        Assert.True(ok, $"expected TryParse to succeed for a path For() itself produced: '{path}'");
        Assert.Equal(pluginFileName, identity.PluginFileName);
        // TryParse answers RecordTypeDispatch's schema-table-name spelling; For() accepts either. The two
        // need not match textually, only resolve to the same concrete type, which this equality checks for
        // real rather than assuming a spelling.
        var expectedConcrete = RecordTypeDispatch.For(Release).ConcreteFor(recordType);
        Assert.NotNull(expectedConcrete);
        Assert.Equal(expectedConcrete, RecordTypeDispatch.For(Release).ConcreteFor(identity.RecordType));
    }

    [Theory]
    [InlineData("SomeNpc", "SomeNpc - 000800_Vendor.esp.json")]
    [InlineData(null, "000800_Vendor.esp.json")]
    public void For_NamesTheRecordByIdentityAlone_WithNoOrderingPrefix(string? editorId, string expectedFileName)
    {
        var path = SourceRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp", editorId, Release);

        Assert.Equal(expectedFileName, Path.GetFileName(path));
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
        // A placed reference lives inside a cell's own document, never under a top-level group of
        // its own: the same "ask SourceUnitResolver" refusal as a directory-per-record type, for
        // another reason.
        Assert.Throws<NotSupportedException>(
            () => SourceRecordPath.For("Vendor.esp", "placedobject", "000800:Vendor.esp", "SomeRef", Release));
    }

    [Theory]
    // Too few / too many path segments — the flat shape is exactly four: source/<plugin>/<folder>/<file>.json.
    [InlineData("source/Vendor.esp/000800.json")]
    [InlineData("source/Vendor.esp/Npcs/Vendor.esp/000800.json")]
    // First segment isn't the literal root folder name at all.
    [InlineData("Vendor.esp/Npcs/000800.json")]
    [InlineData("NotSource/Vendor.esp/Npcs/000800.json")]
    // Root segment present but no plugin segment at all (an empty path component collapses away).
    [InlineData("source//Npcs/000800.json")]
    // Last segment missing the load-bearing ".json" suffix.
    [InlineData("source/Vendor.esp/Npcs/000800.txt")]
    [InlineData("source/Vendor.esp/Npcs/000800")]
    // The whole-mod door's own header/group files — never a flat record's own file.
    [InlineData("source/Vendor.esp/Npcs/RecordData.json")]
    [InlineData("source/Vendor.esp/Cells/GroupRecordData.json")]
    // A folder this game's schema has no group for at all.
    [InlineData("source/Vendor.esp/NotARealFolder/000800.json")]
    // Three segments but not literally RecordData.json — must not be mistaken for the header (#661).
    [InlineData("source/Vendor.esp/NotRecordData.json")]
    public void TryParse_MalformedOrUnmappedPaths_FailsCleanly(string relativePath)
    {
        // Malformed input must fail outright rather than return a wrong parse, which would mislabel a
        // user's change. '/' is deliberate and portable: these theories build the string directly rather
        // than through For(), and every OS accepts it here.
        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);

        var ok = SourceRecordPath.TryParse(normalized, Release, out var identity);

        Assert.False(ok, $"expected TryParse to fail for a malformed or unmapped path: '{relativePath}'");
        Assert.Null(identity);
    }

    // A folder whose group element is abstract reads as ambiguous, the same as the whole-mod door's
    // discriminator policy: the document self-describes rather than TryParse guessing one concrete
    // type from the folder name.
    [Fact]
    public void TryParse_ForAnAmbiguousGroupsFolder_FailsCleanly()
    {
        var ambiguousFolder = RecordTypeDispatch.For(Release).FolderNameFor("globalfloat");
        Assert.NotNull(ambiguousFolder); // sanity: GlobalFloat is a flat type with a real folder...
        var path = Path.Combine(
            SourceRecordPath.RootFolderName, "Vendor.esp", ambiguousFolder!, "SomeGlobal - 000800_Vendor.esp.json");

        var ok = SourceRecordPath.TryParse(path, Release, out var identity);

        Assert.False(ok, "...but that folder is shared with GlobalBool/GlobalInt/GlobalShort, so it must not resolve.");
        Assert.Null(identity);
    }

    [Fact]
    public void TryParse_ForTheRootRecordDataJson_ResolvesTheHeaderIdentity()
    {
        var ok = SourceRecordPath.TryParse(
            Path.Combine("source", "Vendor.esp", "RecordData.json"), Release, out var identity);

        Assert.True(ok);
        Assert.Equal("Vendor.esp", identity.PluginFileName);
        Assert.Equal(HeaderIndexer.RecordType, identity.RecordType);
    }
}
