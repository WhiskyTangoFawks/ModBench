using Octodiff.Core;
using Octodiff.Diagnostics;

namespace MEditService.Commands.Build;

/// <summary>A delta as Wabbajack makes one, so Wabbajack's installer could apply it.</summary>
internal static class OctodiffDelta
{
    public static void Write(Stream basis, Stream file, Stream delta)
    {
        using var signature = new MemoryStream();
        new SignatureBuilder().Build(basis, new SignatureWriter(signature));
        signature.Position = 0;
        new DeltaBuilder().BuildDelta(
            file, new SignatureReader(signature, new NullProgressReporter()), new AggregateCopyOperationsDecorator(new BinaryDeltaWriter(delta)));
    }
}
