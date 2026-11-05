using System.Reflection;

namespace MEditService.Codec.Schema;

/// <summary>A getter that answers as a fresh instance does, under the breaks it is given, and records each
/// member a copy reads. DispatchProxy derives the proxy from it, so it cannot be sealed.</summary>
public class MemberReadRecorder : DispatchProxy
{
    internal object? Target { get; set; }

    internal object? Versioning { get; set; }

    internal HashSet<string> Read { get; } = new(StringComparer.Ordinal);

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod ?? throw new InvalidOperationException("Expected a proxied call to name its method.");
        if (!method.Name.StartsWith("get_", StringComparison.Ordinal)) return method.Invoke(Target, args);
        var member = method.Name["get_".Length..];
        Read.Add(member);
        return member == VersioningBreaks.Member ? Versioning : method.Invoke(Target, args);
    }
}
