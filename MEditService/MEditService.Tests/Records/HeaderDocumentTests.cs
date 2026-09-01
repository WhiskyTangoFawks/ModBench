using System.Text;
using MEditService.Core.Records;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Tests.Records;

/// <summary>
/// The plugin header's document producer/reader (#631), held to the two facts everything else
/// assumes about it.
///
/// <para><b>This is Tests-side deliberately</b>, in the same way <c>DocumentShapeParityTests</c> is:
/// the check compares <c>HeaderDocument</c>'s output against the generated whole-mod mixin used
/// directly, and that mixin is exactly what <c>RecordTextCodecGeneratorSeedTests</c>' whitelist keeps
/// out of <c>MEditService.Core</c>. Comparing against the door from a test is how the two are meant
/// to be checked against each other.</para>
/// </summary>
public sealed class HeaderDocumentTests
{
    private static Fallout4Mod PopulatedMod()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("HeaderDoc.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";
        // Non-ASCII on purpose: the byte comparisons below are the only place an encoding difference
        // between the two producers could show, and pure ASCII would hide one.
        mod.ModHeader.Description = "Cut-down slice — ünïcode, em—dash";
        mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Master | Fallout4ModHeader.HeaderFlag.Localized;
        mod.ModHeader.Stats.NextFormID = 0x900;
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Other.esm") });
        mod.ModHeader.SetOverriddenForms([new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x123)]);

        // Real records, so the "the clone drops the groups" shortcut below is actually exercised
        // against a mod that has groups to drop — including a folder-split container, the shape that
        // makes the whole-mod door write child files at all.
        mod.Weapons.AddNew().EditorID = "SomeWeapon";
        mod.Npcs.AddNew().EditorID = "SomeNpc";
        var quest = new Quest(mod) { EditorID = "SomeQuest" };
        var topic = new DialogTopic(mod) { EditorID = "SomeTopic" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "SomeResponse" });
        quest.DialogTopics.Add(topic);
        mod.Quests.Add(quest);
        return mod;
    }

    /// <summary>
    /// <b>The licence for the header-only clone.</b> <c>HeaderDocument.Write</c> does not serialize
    /// the mod it is given — it deep-copies the header onto an empty mod and serializes that, because
    /// walking a real mod costs 1,510 ms cold / 239 ms warm per plugin against 1 ms for the clone
    /// (measured on the 3,940-record cut-down fixture). That shortcut is only sound while the root
    /// document is a function of the header alone and <c>DeepCopyIn</c> copies all of it. This is the
    /// standing check on both halves at once: a Mutagen/Serialization bump that moved anything into
    /// the root document, or left a header field out of the deep copy, fails here rather than
    /// shipping a header that silently lost a field.
    /// </summary>
    [Fact]
    public async Task Write_ProducesTheSameBytesAsAFullWholeModWrite_ForAModWithRealGroups()
    {
        var mod = PopulatedMod();

        var dir = Directory.CreateTempSubdirectory("medit-headerdoc-").FullName;
        try
        {
            await MutagenJsonConverter.Instance.Serialize(mod, dir);
            var wholeModRoot = StripCarriageReturns(await File.ReadAllBytesAsync(Path.Combine(dir, "RecordData.json")));

            var produced = HeaderDocument.Write(mod);

            // Compared as text first so a failure is readable, then as bytes so the assertion is
            // actually about bytes — a text-only compare cannot see a BOM or an encoding difference.
            Assert.Equal(Encoding.UTF8.GetString(wholeModRoot), Encoding.UTF8.GetString(produced));
            Assert.Equal(wholeModRoot, produced);

            // Positive control: the fixture really does produce child files, so "the clone drops the
            // groups" is a claim this test exercised rather than one it never met.
            Assert.True(
                Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Count() > 1,
                "fixture wrote no child records — the clone shortcut is untested by this comparison.");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>
    /// The canonical form the whole tree is committed in, and the one <c>content_hash</c> is defined
    /// against: bare <c>\n</c>, nothing after the closing brace, no BOM. Stated as its own assertion
    /// rather than left implicit in the byte compare above, because that compare would still pass if
    /// <i>both</i> sides grew a trailing newline together.
    /// </summary>
    [Fact]
    public void Write_ProducesCanonicalBytes_NoCarriageReturnNoTrailingNewlineNoBom()
    {
        var produced = HeaderDocument.Write(PopulatedMod());

        Assert.DoesNotContain((byte)'\r', produced);
        Assert.Equal((byte)'}', produced[^1]);
        Assert.False(produced.Length >= 3 && produced[0] == 0xEF && produced[1] == 0xBB && produced[2] == 0xBF,
            "the document must carry no UTF-8 BOM.");
    }

    /// <summary>
    /// The read side is the inverse of the write side, through the same door — so a header that went
    /// out comes back with every field intact and re-serializes to the identical bytes. Round-trip
    /// identity is what lets the read path extract a header's fields from its stored body instead of
    /// from a wide table.
    /// </summary>
    [Fact]
    public void Read_RoundTripsEveryHeaderField_AndReSerializesToTheSameBytes()
    {
        var mod = PopulatedMod();
        var body = HeaderDocument.Write(mod);

        var readBack = (IFallout4ModGetter)HeaderDocument.Read(body);

        Assert.Equal(mod.ModKey, readBack.ModKey);
        Assert.Equal(mod.GameRelease, readBack.GameRelease);
        Assert.Equal(mod.ModHeader.Author, readBack.ModHeader.Author);
        Assert.Equal(mod.ModHeader.Description, readBack.ModHeader.Description);
        Assert.Equal(mod.ModHeader.Flags, readBack.ModHeader.Flags);
        Assert.Equal(mod.ModHeader.Stats.NextFormID, readBack.ModHeader.Stats.NextFormID);
        Assert.Equal(
            mod.ModHeader.MasterReferences.Select(m => m.Master.FileName.ToString()),
            readBack.ModHeader.MasterReferences.Select(m => m.Master.FileName.ToString()));

        Assert.Equal(body, HeaderDocument.Write(readBack));
    }

    /// <summary>
    /// The document describes the header and nothing else: reading it back yields a mod with no
    /// records, rather than one that quietly picked up whatever happened to be on disk near the
    /// synthetic folder path the reader names.
    /// </summary>
    [Fact]
    public void Read_YieldsAModWithNoRecords()
    {
        var readBack = HeaderDocument.Read(HeaderDocument.Write(PopulatedMod()));

        Assert.Empty(readBack.EnumerateMajorRecords());
    }

    /// <summary>Neither direction may touch the filesystem — the write side is on the indexing path
    /// (once per plugin) and the read side on the record editor's, and a temp file per call on either
    /// would be both slower and a new never-assume-exclusive-ownership hazard.</summary>
    [Fact]
    public void WriteAndRead_CreateNothingOnDisk()
    {
        var before = Directory.EnumerateFileSystemEntries(Path.GetTempPath(), "medit-header-*").ToHashSet(StringComparer.Ordinal);

        var body = HeaderDocument.Write(PopulatedMod());
        HeaderDocument.Read(body);

        var after = Directory.EnumerateFileSystemEntries(Path.GetTempPath(), "medit-header-*").ToHashSet(StringComparer.Ordinal);
        Assert.Empty(after.Except(before, StringComparer.Ordinal));
    }

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}
