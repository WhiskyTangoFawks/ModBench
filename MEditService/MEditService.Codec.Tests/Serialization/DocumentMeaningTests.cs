using System.Text;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentMeaningTests
{
    private static string? Difference(string held, string produced) =>
        DocumentMeaning.FirstDifference(Encoding.UTF8.GetBytes(held), Encoding.UTF8.GetBytes(produced));

    [Theory]
    [InlineData("""{"A":1,"B":2}""", """{ "B": 2, "A": 1 }""")]
    [InlineData("""{"A":[1,2]}""", "{\n  \"A\": [ 1, 2 ]\n}")]
    [InlineData("""{"A":2.5}""", """{"A":2.50}""")]
    [InlineData("""{"A":0.1}""", """{"A":0.10000000149011612}""")]
    [InlineData("""{"A":1,"B":[]}""", """{"A":1}""")]
    [InlineData("""{"A":1}""", """{"A":1,"B":[]}""")]
    public void TwoDocumentsOfOneMeaning_HaveNoDifference(string held, string produced)
    {
        Assert.Null(Difference(held, produced));
    }

    [Theory]
    [InlineData("""{"A":9007199254740993}""", """{"A":9007199254740992}""", "A")]
    [InlineData("""{"A":{"B":[1,2]}}""", """{"A":{"B":[2,1]}}""", "A.B[0]")]
    [InlineData("""{"A":1}""", """{"A":1,"B":2}""", "B")]
    [InlineData("""{"A":"1"}""", """{"A":1}""", "A")]
    [InlineData("not json", """{"A":1}""", "the document")]
    public void TwoDocumentsOfAnotherMeaning_NameTheFirstMemberThatDiffers(string held, string produced, string path)
    {
        Assert.Equal(path, Difference(held, produced));
    }
}
