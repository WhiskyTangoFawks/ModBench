using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public class FormKeyComparerTests
{
    [Theory]
    [InlineData("000800:Master.esm", "000800_master.ESM")]
    [InlineData("00080a:Master.esm", "00080A:Master.esm")]
    [InlineData("garbage", "garbage")]
    public void TwoSpellingsMutagenReadsAsOne_AreOneFormKey_HashingAlike(string left, string right)
    {
        Assert.True(FormKeyComparer.Instance.Equals(left, right));
        Assert.Equal(FormKeyComparer.Instance.GetHashCode(left), FormKeyComparer.Instance.GetHashCode(right));
    }

    [Theory]
    [InlineData("000800:Master.esm", "000801:Master.esm")]
    [InlineData("garbage", "000800:Master.esm")]
    public void TwoSpellingsMutagenReadsAsTwo_AreTwoFormKeys(string left, string right)
    {
        Assert.False(FormKeyComparer.Instance.Equals(left, right));
    }
}
