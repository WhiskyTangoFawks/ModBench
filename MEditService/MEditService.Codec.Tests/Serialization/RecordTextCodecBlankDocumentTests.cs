using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordTextCodecBlankDocumentTests
{
    [Fact]
    public void AContainerLevelsBlankDocument_IsSpelledByTheCodec_NotByTheIdentityGiven_BecauseTheCodecMintsTheDocumentOfAnEmptyInstanceSoNothingOutsideItConstructsAContainerLevel()
    {
        var document = RecordTextCodec.BlankDocument(
            nameof(WorldspaceBlock), GameRelease.Fallout4,
            Document.Empty.With(3, "BlockNumberX").With(-2, "BlockNumberY"));

        Assert.Equal("{\n  \"BlockNumberY\": -2,\n  \"BlockNumberX\": 3\n}", document);
    }

    [Fact]
    public void AContainerLevelsBlankDocument_ReadsBackAsItself()
    {
        var document = RecordTextCodec.BlankDocument(
            nameof(WorldspaceBlock), GameRelease.Fallout4,
            Document.Empty.With(3, "BlockNumberX").With(-2, "BlockNumberY"));

        var readBackAndWritten = RecordTextCodec.BlankDocument(
            nameof(WorldspaceBlock), GameRelease.Fallout4, Document.Parse(document));

        Assert.Equal(document, readBackAndWritten);
    }

    [Fact]
    public void ABlankDocumentGivenNoIdentity_NamesNoMemberAtAll()
    {
        var document = RecordTextCodec.BlankDocument(nameof(WorldspaceSubBlock), GameRelease.Fallout4, Document.Empty);

        using var parsed = JsonDocument.Parse(document);
        Assert.Empty(parsed.RootElement.EnumerateObject());
    }

    [Fact]
    public void AContainerRecordsBlankDocument_IsItsFormKeyAlone_AndReadsBackAsItself()
    {
        var identity = Document.Empty.With("000802:Source.esm", "FormKey");

        var document = RecordTextCodec.BlankDocument("cell", GameRelease.Fallout4, identity);

        Assert.Equal("{\n  \"FormKey\": \"000802:Source.esm\"\n}", document);
        Assert.Equal(
            document,
            RecordTextCodec.BlankDocument(
                "cell", GameRelease.Fallout4, Document.Parse(document)));
    }
}
