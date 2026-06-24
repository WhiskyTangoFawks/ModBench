namespace MEditService.Core.Edits;

public static class VmadPath
{
    public const string Prefix = @"VMAD\";

    public static bool IsVmadPath(string path) =>
        path.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase);

    public static string Build(string scriptName, string propertyName) =>
        $@"VMAD\{scriptName}\{propertyName}";

    public static bool TryParse(string path, out string scriptName, out string propertyName)
    {
        scriptName = propertyName = "";
        if (!IsVmadPath(path)) return false;
        var rest = path[Prefix.Length..];
        var sep = rest.IndexOf('\\');
        if (sep <= 0 || sep == rest.Length - 1) return false;
        scriptName = rest[..sep];
        propertyName = rest[(sep + 1)..];
        return true;
    }

    // Parses a script-level path "VMAD\<ScriptName>" (no property segment).
    public static bool TryParseScript(string path, out string scriptName)
    {
        scriptName = "";
        if (!IsVmadPath(path)) return false;
        var rest = path[Prefix.Length..];
        if (rest.Length == 0 || rest.Contains('\\')) return false;
        scriptName = rest;
        return true;
    }
}
