using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Tests.Serialization;

public sealed class EncodingNormalizationTests
{
    private static readonly ModKey Master = ModKey.FromFileName("Localized.esm");

    private static TranslatedString Named(params (Language Language, string Text)[] texts) =>
        new(Language.English, texts.Select(text => new KeyValuePair<Language, string>(text.Language, text.Text)));

    public static TheoryData<string, TranslatedString> StringsOfALocalizedMaster => new()
    {
        { "in several languages", Named((Language.English, "The Big Door"), (Language.French, "La Grande Porte")) },
        { "with no text in its target language", Named((Language.French, "La Grande Porte")) },
        { "with no text", Named() },
    };

    [Theory]
    [MemberData(nameof(StringsOfALocalizedMaster))]
    public void AStringReadFromALocalizedMaster_WrittenIntoAPluginNotLocalized_IsTheStringItsRereadHolds(string _, TranslatedString name)
    {
        var master = new Fallout4Mod(Master, Fallout4Release.Fallout4) { UsingLocalization = true };
        master.Doors.AddNew("Door").Name = name;

        var (read, reread) = ReadThenRewrittenNotLocalized(master, (patch, door) => patch.Doors.Add((Door)door));

        Assert.Equal(Normalized(reread), Normalized(read));
    }

    [Fact]
    public void AStructReadFromBytesThatEndAtItsFirstBreak_WrittenAndReread_IsTheStructItsRereadHolds()
    {
        var master = new Fallout4Mod(Master, Fallout4Release.Fallout4);
        master.AddInteriorCells(new Cell(master)
        {
            EditorID = "Lit",
            Flags = Cell.Flag.IsInteriorCell,
            Lighting = new CellLighting { Versioning = CellLighting.VersioningBreaks.Break0 },
        });

        var (read, reread) = ReadThenRewrittenNotLocalized(master, (patch, cell) => patch.AddInteriorCells((Cell)cell));

        Assert.Equal(Normalized(reread), Normalized(read));
    }

    private static string Normalized(IMajorRecordGetter record) =>
        RecordTextCodec.SerializeToText(
            GameCodecs.For(GameRelease.Fallout4).NormalizeEncoding(record, localized: false, _ => null), GameRelease.Fallout4);

    private static (IMajorRecordGetter Read, IMajorRecordGetter Reread) ReadThenRewrittenNotLocalized(
        Fallout4Mod master, Action<Fallout4Mod, IMajorRecord> add)
    {
        using var scratch = new ScratchDirectory("medit-encoding-");
        var masterPath = Path.Combine(scratch.Path, Master.FileName);
        master.WriteToBinary(masterPath);
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(Master, masterPath), Fallout4Release.Fallout4,
            new BinaryReadParameters { StringsParam = new StringsReadParameters { StringsFolderOverride = Path.Combine(scratch.Path, "Strings") } });
        var read = overlay.EnumerateMajorRecords().Single().DeepCopy();

        var patch = new Fallout4Mod(ModKey.FromFileName("Patch.esp"), Fallout4Release.Fallout4);
        add(patch, read.DeepCopy());
        var patchPath = Path.Combine(scratch.Path, patch.ModKey.FileName);
        patch.WriteToBinary(patchPath);
        return (read, ModFactory.ImportSetter(new ModPath(patch.ModKey, patchPath), GameRelease.Fallout4).EnumerateMajorRecords().Single());
    }
}
