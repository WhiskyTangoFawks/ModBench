using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Tests.Records;

/// <summary>Tests-side deliberately: the check compares against the generated whole-mod mixin,
/// which <c>RecordTextCodecGeneratorSeedTests</c>' whitelist keeps out of Core.</summary>
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
        // against a mod that has groups to drop — including a container holding nested records.
        mod.Weapons.AddNew().EditorID = "SomeWeapon";
        mod.Npcs.AddNew().EditorID = "SomeNpc";
        var quest = new Quest(mod) { EditorID = "SomeQuest" };
        var topic = new DialogTopic(mod) { EditorID = "SomeTopic" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "SomeResponse" });
        quest.DialogTopics.Add(topic);
        mod.Quests.Add(quest);
        return mod;
    }

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

    [Fact]
    public void Write_ProducesCanonicalBytes_NoCarriageReturnNoTrailingNewlineNoBom()
    {
        var produced = HeaderDocument.Write(PopulatedMod());

        Assert.DoesNotContain((byte)'\r', produced);
        Assert.Equal((byte)'}', produced[^1]);
        Assert.False(produced.Length >= 3 && produced[0] == 0xEF && produced[1] == 0xBB && produced[2] == 0xBF,
            "the document must carry no UTF-8 BOM.");
    }

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

    [Fact]
    public void Read_YieldsAModWithNoRecords()
    {
        var readBack = HeaderDocument.Read(HeaderDocument.Write(PopulatedMod()));

        Assert.Empty(readBack.EnumerateMajorRecords());
    }

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
